import assert from 'node:assert/strict'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApi, openDatabase } from '../api.mjs'
import { createHandler } from '../server.mjs'

const TOKEN = 'test-import-token-0123456789abcdef'
let server, origin, api

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduling-'))
  mkdirSync(join(dir, 'event'))
  mkdirSync(join(dir, '_next', 'static'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), 'home')
  writeFileSync(join(dir, 'event', 'index.html'), 'event page')
  writeFileSync(join(dir, '404.html'), 'missing')
  writeFileSync(join(dir, 'llms.txt'), 'docs')
  writeFileSync(join(dir, '_next', 'static', 'app.js'), 'js')

  api = createApi(openDatabase(':memory:'))
  const handle = createHandler({ api, staticDir: dir, importToken: TOKEN })
  server = createServer((req, res) => { void handle(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const call = async (path, { method = 'GET', body, headers } = {}) => {
  const res = await fetch(`${origin}/scheduling/api${path}`, {
    method,
    headers: { ...body && { 'content-type': 'application/json' }, ...headers },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, body: await res.json(), headers: res.headers }
}
const bearer = password => ({ authorization: `Bearer ${Buffer.from(password).toString('base64')}` })
const newEvent = () => call('/event', {
  method: 'POST',
  body: { name: 'Team lunch', times: ['1700-25102026', '1800-25102026'], timezone: 'America/Los_Angeles' },
})

test('static pages are served with and without the trailing slash', async () => {
  for (const path of ['/scheduling', '/scheduling/']) {
    const res = await fetch(origin + path)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'home')
    assert.equal(res.headers.get('cache-control'), 'no-cache')
  }
  for (const path of ['/scheduling/event?id=x', '/scheduling/event/?id=x&key=y']) {
    const res = await fetch(origin + path)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'event page')
  }
  const docs = await fetch(`${origin}/scheduling/llms.txt`)
  assert.match(docs.headers.get('content-type'), /^text\/plain/)
})

test('build assets are cached forever, unknown paths get the 404 page', async () => {
  const asset = await fetch(`${origin}/scheduling/_next/static/app.js`)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  for (const path of ['/scheduling/nope', '/scheduling/nope.js', '/', '/elsewhere']) {
    const res = await fetch(origin + path)
    assert.equal(res.status, 404, path)
    assert.equal(await res.text(), 'missing')
  }
})

test('paths cannot escape the static folder', async () => {
  // fetch() would tidy these paths up before sending them, so send them raw
  const rawStatus = path => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.address().port, path }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject).end()
  })
  for (const path of ['/scheduling/%2e%2e/%2e%2e/etc/passwd', '/scheduling/../server.mjs', '/scheduling/.env', '/scheduling/..%2fserver.mjs']) {
    assert.equal(await rawStatus(path), 400, path)
  }
})

test('health check', async () => {
  const res = await fetch(`${origin}/healthz`)
  assert.deepEqual(await res.json(), { ok: true })
})

test('create an event, sign up, set availability, read it back', async () => {
  const created = await newEvent()
  assert.equal(created.status, 201)
  assert.match(created.body.id, /^team-lunch-\d{6}$/)
  assert.ok(created.body.edit_key)
  const { id } = created.body

  const event = await call(`/event/${id}`)
  assert.equal(event.status, 200)
  assert.equal(event.body.name, 'Team lunch')
  assert.equal(event.body.edit_key, undefined)
  assert.equal(event.headers.get('access-control-allow-origin'), '*')

  const signup = await call(`/event/${id}/people/Alice`, { headers: bearer('hunter2') })
  assert.deepEqual(signup.body.availability, [])

  assert.equal((await call(`/event/${id}/people/alice`, { headers: bearer('wrong') })).status, 401)
  assert.equal((await call(`/event/${id}/people/ALICE`, { headers: bearer('hunter2') })).status, 200)

  // People with no availability yet are not listed
  assert.deepEqual((await call(`/event/${id}/people`)).body, [])

  const denied = await call(`/event/${id}/people/Alice`, { method: 'PATCH', body: { availability: ['1700-25102026'] }, headers: bearer('wrong') })
  assert.equal(denied.status, 401)
  const saved = await call(`/event/${id}/people/Alice`, { method: 'PATCH', body: { availability: ['1700-25102026'] }, headers: bearer('hunter2') })
  assert.equal(saved.status, 200)

  const people = await call(`/event/${id}/people`)
  assert.equal(people.body.length, 1)
  assert.equal(people.body[0].name, 'Alice')
  assert.deepEqual(people.body[0].availability, ['1700-25102026'])
  assert.equal(people.body[0].password_hash, undefined)
})

test('a person without a password can log in with or without one', async () => {
  const { body: { id } } = await newEvent()
  assert.equal((await call(`/event/${id}/people/Bob`)).status, 200)
  assert.equal((await call(`/event/${id}/people/Bob`, { headers: bearer('anything') })).status, 200)
})

test('only the edit key can change an event', async () => {
  const { body: { id, edit_key } } = await newEvent()
  const change = { name: 'Team dinner', times: ['0100-26102026'] }

  assert.equal((await call(`/event/${id}`, { method: 'PATCH', body: change })).status, 403)
  assert.equal((await call(`/event/${id}`, { method: 'PATCH', body: change, headers: { 'x-edit-key': 'nope' } })).status, 403)

  const edited = await call(`/event/${id}`, { method: 'PATCH', body: change, headers: { 'x-edit-key': edit_key } })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.id, id)

  const event = await call(`/event/${id}`)
  assert.equal(event.body.name, 'Team dinner')
  assert.deepEqual(event.body.times, ['0100-26102026'])
  assert.equal(event.body.timezone, 'America/Los_Angeles')
})

test('bad input and unknown things', async () => {
  assert.equal((await call('/event', { method: 'POST', body: { times: [], timezone: 'UTC' } })).status, 422)
  assert.equal((await call('/event', { method: 'POST', body: { times: ['1700-3'] } })).status, 422)
  assert.equal((await call('/event/nope-123456')).status, 404)
  assert.equal((await call('/event/nope-123456/people')).status, 404)
  assert.equal((await call('/event/nope-123456/people/Alice')).status, 404)
  assert.equal((await call('/nothing')).status, 404)

  const res = await fetch(`${origin}/scheduling/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
  assert.equal(res.status, 415)

  const huge = await fetch(`${origin}/scheduling/api/event`, { method: 'POST', body: 'x'.repeat(300 * 1024) })
  assert.equal(huge.status, 413)
})

test('an event with no name gets a generated one', async () => {
  const created = await call('/event', { method: 'POST', body: { times: ['1700-3'], timezone: 'UTC' } })
  assert.equal(created.status, 201)
  assert.match(created.body.name, /^\S+ (Hangout|Meetup|Get-together|Gathering|Catch-up)$/)
})

test('import needs the token, keeps passwords and edit keys working, and can be re-run', async () => {
  const editKey = 'old-edit-key'
  const dump = {
    events: [{
      id: 'old-event-111111', name: 'Old event', times: ['1700-25102026'], timezone: 'UTC',
      created_at: 1760000000, visited_at: 1760000500,
      edit_key_hash: createHash('sha256').update(editKey).digest('base64'),
    }, {
      id: 'older-event-222222', name: 'No key', times: ['1700-3'], timezone: 'UTC', created_at: 1750000000,
    }],
    people: [
      { event_id: 'old-event-111111', name: 'Carol', created_at: 1760000100, availability: ['1700-25102026'] },
      { event_id: 'gone-333333', name: 'Dave', created_at: 1760000100, availability: [] },
    ],
  }
  const post = (body, token) => fetch(`${origin}/scheduling/api/admin/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...token && { authorization: `Bearer ${token}` } },
    body: JSON.stringify(body),
  })

  assert.equal((await post(dump)).status, 404)
  assert.equal((await post(dump, 'wrong-token-wrong-token-wrong-token')).status, 404)
  assert.equal((await post({ events: [{ id: 'x' }], people: [] }, TOKEN)).status, 422)

  const first = await post(dump, TOKEN)
  assert.equal(first.status, 200)
  const summary = await first.json()
  assert.equal(summary.events, 2)
  assert.equal(summary.people, 1)
  assert.equal(summary.skipped_people, 1)

  assert.deepEqual((await call('/event/old-event-111111/people')).body.map(p => p.name), ['Carol'])
  const edited = await call('/event/old-event-111111', { method: 'PATCH', body: { name: 'Renamed' }, headers: { 'x-edit-key': editKey } })
  assert.equal(edited.status, 200)

  // Running the import again restores the dump's version instead of duplicating rows
  assert.equal((await post(dump, TOKEN)).status, 200)
  assert.equal((await call('/event/old-event-111111')).body.name, 'Old event')
  assert.equal((await call('/event/old-event-111111/people')).body.length, 1)
})

test('a password hash made by the old backend still verifies after import', async () => {
  // The Lambda stored scrypt$<salt>$<hash>, both base64, with a 32-byte key
  const salt = randomBytes(16)
  const hash = `scrypt$${salt.toString('base64')}$${scryptSync('s3cret', salt, 32).toString('base64')}`
  const out = api.importDump({
    events: [{ id: 'moved-444444', name: 'Moved', times: ['1700-3'], timezone: 'UTC', created_at: 1 }],
    people: [{ event_id: 'moved-444444', name: 'Erin', password_hash: hash, created_at: 2, availability: ['1700-3'] }],
  })
  assert.equal(out.statusCode, 200)
  assert.equal((await call('/event/moved-444444/people/erin', { headers: bearer('s3cret') })).status, 200)
  assert.equal((await call('/event/moved-444444/people/erin', { headers: bearer('wrong') })).status, 401)

  const bad = { event_id: 'moved-444444', name: 'Frank', password_hash: 'bcrypt$nope', created_at: 1, availability: [] }
  assert.equal(api.importDump({ events: [], people: [bad] }).statusCode, 422)
})

test('add-edit-key only fills in a missing key', async () => {
  const hash = createHash('sha256').update('fresh').digest('base64')
  assert.equal(api.addEditKeyHash('older-event-222222', hash), true)
  assert.equal(api.addEditKeyHash('older-event-222222', hash), false)
  assert.equal(api.addEditKeyHash('missing-999999', hash), false)
  const edited = await call('/event/older-event-222222', { method: 'PATCH', body: { name: 'Now editable' }, headers: { 'x-edit-key': 'fresh' } })
  assert.equal(edited.status, 200)
})
