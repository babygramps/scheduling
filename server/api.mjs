// Crab Fit API for /scheduling: a port of the upstream Rust API
// (github.com/GRA0007/crab.fit, api/src/routes) onto SQLite, served by
// server.mjs under /scheduling/api/.
//
// GET   /stats
// POST  /event                              { name?, times, timezone }
// GET   /event/:id
// GET   /event/:id/people
// GET   /event/:id/people/:name             login, or sign up if new
// PATCH /event/:id/people/:name             { availability }
// PATCH /event/:id                          { name?, times?, timezone? }, creator only
//
// Creating an event returns an edit_key (only that once). Editing the event
// needs it in an X-Edit-Key header; only its SHA-256 is stored.
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import punycode from 'node:punycode'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const VERSION = '4.0.0'

// Upstream has no explicit limits; these keep any one event to a sane size.
const MAX_NAME = 100
const MAX_TIMES = 5000

const adjectives = JSON.parse(readFileSync(new URL('./adjectives.json', import.meta.url)))
const kinds = ['Hangout', 'Meetup', 'Get-together', 'Gathering', 'Catch-up']

const scryptAsync = promisify(scrypt)

const json = (statusCode, body) => ({ statusCode, body })
const error = (statusCode, message) => json(statusCode, { error: message })

const nowSeconds = () => Math.floor(Date.now() / 1000)
const pick = list => list[randomInt(list.length)]
const isStringArray = (v, max) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && x.length <= 20)

// Same shape as upstream's generate_name / generate_id / encode_name
const generateName = () => `${pick(adjectives)} ${pick(kinds)}`
const encodeName = name => {
  let pc
  try { pc = punycode.encode(name.trim().toLowerCase()) } catch { pc = '' }
  return pc.trim().replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-')
}
const generateId = name => {
  let id = encodeName(name)
  if (!id.replace(/-/g, '')) id = encodeName(generateName())
  return `${id}-${randomInt(100000, 1000000)}`
}

// Upstream uses bcrypt; scrypt is built into Node so there are no dependencies
const hashPassword = async raw => {
  const salt = randomBytes(16)
  const hash = await scryptAsync(raw, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}
const verifyPassword = async (person, raw) => {
  // A person who didn't set a password can log in with or without one
  if (!person.password_hash) return true
  const [, salt, expected] = person.password_hash.split('$')
  const actual = await scryptAsync(raw ?? '', Buffer.from(salt, 'base64'), 32)
  return timingSafeEqual(actual, Buffer.from(expected, 'base64'))
}

// Edit keys are 192 random bits, so a plain hash is enough to store them
const hashEditKey = key => createHash('sha256').update(key).digest('base64')
const verifyEditKey = (event, key) => {
  if (!event.edit_key_hash || !key) return false
  const actual = Buffer.from(hashEditKey(key), 'base64')
  const expected = Buffer.from(event.edit_key_hash, 'base64')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Authorization: Bearer <base64 password>
const parsePassword = headers => {
  const auth = headers?.authorization
  if (!auth?.toLowerCase().startsWith('bearer ')) return undefined
  return Buffer.from(auth.slice(7).trim(), 'base64').toString('utf8')
}

const eventResponse = e => ({ id: e.id, name: e.name, times: e.times, timezone: e.timezone, created_at: e.created_at })
const personResponse = p => ({ name: p.name, availability: p.availability ?? [], created_at: p.created_at })

const validTimes = times => isStringArray(times, MAX_TIMES) && times.length > 0
const validTimezone = timezone => typeof timezone === 'string' && timezone.length > 0 && timezone.length <= 100

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    times         TEXT NOT NULL,      -- JSON array of strings
    timezone      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,   -- Unix seconds
    visited_at    INTEGER NOT NULL,
    edit_key_hash TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS people (
    event_id      TEXT NOT NULL REFERENCES events(id),
    name_key      TEXT NOT NULL,      -- lowercased name; one person per event
    name          TEXT NOT NULL,
    password_hash TEXT,
    created_at    INTEGER NOT NULL,
    availability  TEXT NOT NULL,      -- JSON array of strings
    PRIMARY KEY (event_id, name_key)
  ) STRICT;
`

/** Opens (and if needed creates) the database at `path`; ':memory:' for tests. */
export function openDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

export function createApi(db) {
  const q = {
    counts: db.prepare('SELECT (SELECT COUNT(*) FROM events) AS event_count, (SELECT COUNT(*) FROM people) AS person_count'),
    getEvent: db.prepare('SELECT * FROM events WHERE id = ?'),
    insertEvent: db.prepare(`INSERT INTO events (id, name, times, timezone, created_at, visited_at, edit_key_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`),
    updateEvent: db.prepare('UPDATE events SET name = ?, times = ?, timezone = ? WHERE id = ?'),
    visitEvent: db.prepare('UPDATE events SET visited_at = ? WHERE id = ?'),
    setEditKeyHash: db.prepare('UPDATE events SET edit_key_hash = ? WHERE id = ? AND edit_key_hash IS NULL'),
    getPeople: db.prepare('SELECT * FROM people WHERE event_id = ? ORDER BY created_at, name_key'),
    getPerson: db.prepare('SELECT * FROM people WHERE event_id = ? AND name_key = ?'),
    insertPerson: db.prepare(`INSERT INTO people (event_id, name_key, name, password_hash, created_at, availability)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (event_id, name_key) DO NOTHING`),
    updateAvailability: db.prepare('UPDATE people SET availability = ? WHERE event_id = ? AND name_key = ?'),
    upsertEvent: db.prepare(`INSERT INTO events (id, name, times, timezone, created_at, visited_at, edit_key_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, times = excluded.times,
      timezone = excluded.timezone, created_at = excluded.created_at, visited_at = excluded.visited_at,
      edit_key_hash = excluded.edit_key_hash`),
    upsertPerson: db.prepare(`INSERT INTO people (event_id, name_key, name, password_hash, created_at, availability)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (event_id, name_key) DO UPDATE SET name = excluded.name,
      password_hash = excluded.password_hash, created_at = excluded.created_at, availability = excluded.availability`),
  }

  const getEvent = id => {
    const row = q.getEvent.get(id)
    return row && { ...row, times: JSON.parse(row.times) }
  }
  const parsePerson = row => row && { ...row, availability: JSON.parse(row.availability) }

  function createEvent(input) {
    if (!input || !validTimes(input.times) || !validTimezone(input.timezone)) {
      return error(422, 'Invalid input provided')
    }
    if (input.name != null && typeof input.name !== 'string') return error(422, 'Invalid input provided')

    const name = input.name?.trim() ? input.name.trim().slice(0, MAX_NAME) : generateName()
    const now = nowSeconds()
    const editKey = randomBytes(24).toString('base64url')

    // Claim a fresh id; the insert does nothing if another create already took it
    for (;;) {
      const event = { id: generateId(name), name, times: input.times, timezone: input.timezone, created_at: now }
      const { changes } = q.insertEvent.run(event.id, name, JSON.stringify(event.times), event.timezone, now, now, hashEditKey(editKey))
      if (changes) return json(201, { ...eventResponse(event), edit_key: editKey })
    }
  }

  function updateEvent(id, editKey, input) {
    if (!input || typeof input !== 'object') return error(422, 'Invalid input provided')
    if (input.name != null && (typeof input.name !== 'string' || !input.name.trim())) return error(422, 'Invalid input provided')
    if (input.times != null && !validTimes(input.times)) return error(422, 'Invalid input provided')
    if (input.timezone != null && !validTimezone(input.timezone)) return error(422, 'Invalid input provided')

    const event = getEvent(id)
    if (!event) return error(404, 'Not found')
    if (!verifyEditKey(event, editKey)) return error(403, 'Only the event creator can edit it')

    // The id stays the same so existing share links keep working
    const updated = {
      ...event,
      ...input.name != null && { name: input.name.trim().slice(0, MAX_NAME) },
      ...input.times != null && { times: input.times },
      ...input.timezone != null && { timezone: input.timezone },
    }
    q.updateEvent.run(updated.name, JSON.stringify(updated.times), updated.timezone, id)
    return json(200, eventResponse(updated))
  }

  async function getPerson(id, name, password) {
    if (!q.getEvent.get(id)) return error(404, 'Not found')

    const existing = parsePerson(q.getPerson.get(id, name.toLowerCase()))
    if (existing) {
      return await verifyPassword(existing, password)
        ? json(200, personResponse(existing))
        : error(401, 'Not authorized')
    }

    // Sign up
    if (!name.trim() || name.length > MAX_NAME) return error(422, 'Invalid input provided')
    const person = {
      name,
      password_hash: password != null ? await hashPassword(password) : null,
      created_at: nowSeconds(),
      availability: [],
    }
    const { changes } = q.insertPerson.run(id, name.toLowerCase(), name, person.password_hash, person.created_at, '[]')
    // Someone signed up with this name while the password was hashing; make them log in
    if (!changes) return getPerson(id, name, password)
    return json(200, personResponse(person))
  }

  async function updatePerson(id, name, password, input) {
    if (!input || !isStringArray(input.availability, MAX_TIMES)) return error(422, 'Invalid input provided')

    if (!q.getEvent.get(id)) return error(404, 'Not found')
    const existing = parsePerson(q.getPerson.get(id, name.toLowerCase()))
    if (!existing) return error(404, 'Not found')
    if (!await verifyPassword(existing, password)) return error(401, 'Not authorized')

    q.updateAvailability.run(JSON.stringify(input.availability), id, existing.name_key)
    return json(200, personResponse({ ...existing, availability: input.availability }))
  }

  /** Handles one request. `path` is relative to the API root, e.g. /event/abc-123456. */
  async function route(method, path, headers, body) {
    let parts
    try { parts = path.split('/').filter(Boolean).map(decodeURIComponent) } catch { return error(400, 'Invalid path') }
    let input
    if (body) {
      try { input = JSON.parse(body) } catch { return error(415, 'Unsupported input format') }
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'stats') {
      return json(200, { ...q.counts.get(), version: VERSION })
    }
    if (parts[0] !== 'event') return error(404, 'Not found')

    if (method === 'POST' && parts.length === 1) return createEvent(input)

    const [, id, sub, name] = parts
    if (method === 'GET' && parts.length === 2) {
      const event = getEvent(id)
      if (!event) return error(404, 'Not found')
      q.visitEvent.run(nowSeconds(), id)
      return json(200, eventResponse(event))
    }
    if (method === 'PATCH' && parts.length === 2) return updateEvent(id, headers?.['x-edit-key'], input)
    if (sub !== 'people') return error(404, 'Not found')
    if (method === 'GET' && parts.length === 3) {
      if (!q.getEvent.get(id)) return error(404, 'Not found')
      return json(200, q.getPeople.all(id).map(parsePerson).filter(p => p.availability.length).map(personResponse))
    }
    if (parts.length === 4) {
      const password = parsePassword(headers)
      if (method === 'GET') return getPerson(id, name, password)
      if (method === 'PATCH') return updatePerson(id, name, password, input)
    }
    return error(404, 'Not found')
  }

  const isInt = v => Number.isSafeInteger(v) && v >= 0
  const validEvent = e => e && typeof e.id === 'string' && e.id && typeof e.name === 'string'
    && Array.isArray(e.times) && e.times.every(t => typeof t === 'string') && typeof e.timezone === 'string'
    && isInt(e.created_at) && (e.visited_at == null || isInt(e.visited_at))
    && (e.edit_key_hash == null || typeof e.edit_key_hash === 'string')
  const validPerson = p => p && typeof p.event_id === 'string' && typeof p.name === 'string' && p.name
    && (p.password_hash == null || /^scrypt\$[^$]+\$[^$]+$/.test(p.password_hash)) && isInt(p.created_at)
    && Array.isArray(p.availability) && p.availability.every(t => typeof t === 'string')

  /**
   * Loads a dump of the old DynamoDB table: { events: [...], people: [...] }.
   * Rows that already exist are replaced, so it is safe to run again before
   * cutover. Nothing is written unless every row is valid.
   */
  function importDump(dump) {
    const events = dump?.events, people = dump?.people
    if (!Array.isArray(events) || !Array.isArray(people)) return error(422, 'Expected { events: [], people: [] }')
    const badEvent = events.findIndex(e => !validEvent(e))
    if (badEvent !== -1) return error(422, `Invalid event at index ${badEvent}`)
    const badPerson = people.findIndex(p => !validPerson(p))
    if (badPerson !== -1) return error(422, `Invalid person at index ${badPerson}`)

    const ids = new Set(events.map(e => e.id))
    let orphans = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const e of events) {
        q.upsertEvent.run(e.id, e.name, JSON.stringify(e.times), e.timezone, e.created_at, e.visited_at ?? e.created_at, e.edit_key_hash ?? null)
      }
      for (const p of people) {
        // A person whose event is gone can never be reached; skip rather than fail
        if (!ids.has(p.event_id) && !q.getEvent.get(p.event_id)) { orphans++; continue }
        q.upsertPerson.run(p.event_id, p.name.toLowerCase(), p.name, p.password_hash ?? null, p.created_at, JSON.stringify(p.availability))
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return json(200, { events: events.length, people: people.length - orphans, skipped_people: orphans, totals: q.counts.get() })
  }

  /**
   * Attaches an edit key to an event that has none (events made before editing
   * existed). Takes the base64 SHA-256 of the key; returns whether it was set.
   */
  const addEditKeyHash = (id, hash) => q.setEditKeyHash.run(hash, id).changes === 1

  return { route, importDump, addEditKeyHash }
}
