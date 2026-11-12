// Serves bigdogflip.com/scheduling: the static export of ../web (web/out) and
// the API (api.mjs) under /scheduling/api/, from one process with no
// dependencies. Data lives in a SQLite file under DATA_DIR.
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi, openDatabase } from './api.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const BASE = '/scheduling'
const API = `${BASE}/api`
const MAX_BODY = 256 * 1024
const MAX_IMPORT_BODY = 64 * 1024 * 1024

const types = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

// The website calls the API from its own origin, but agents and local builds
// call it from elsewhere, as they could with the Lambda function URL.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-edit-key',
  'Access-Control-Max-Age': '86400',
}

const readBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const tokenMatches = (header, token) => {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Builds the request handler.
 * - staticDir: the static export (contains index.html, event/, _next/, ...)
 * - importToken: enables POST /scheduling/api/admin/import when set
 */
export function createHandler({ api, staticDir, importToken }) {
  const root = resolve(staticDir)

  const send = (req, res, status, headers, body) => {
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  const sendJson = (req, res, status, value, headers = {}) =>
    send(req, res, status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, JSON.stringify(value))

  async function handleApi(req, res, path) {
    if (req.method === 'OPTIONS') return send(req, res, 204, cors, '')

    if (path === '/admin/import') {
      // Looks like any other unknown route unless the token is configured and correct
      if (!importToken || req.method !== 'POST' || !tokenMatches(req.headers.authorization, importToken)) {
        return sendJson(req, res, 404, { error: 'Not found' })
      }
      const body = await readBody(req, MAX_IMPORT_BODY)
      if (body == null) return sendJson(req, res, 413, { error: 'Request body is too large' })
      let dump
      try { dump = JSON.parse(body) } catch { return sendJson(req, res, 415, { error: 'Unsupported input format' }) }
      const out = api.importDump(dump)
      console.log('Import:', JSON.stringify(out.body))
      return sendJson(req, res, out.statusCode, out.body)
    }

    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req, MAX_BODY) : ''
    if (body == null) return sendJson(req, res, 413, { error: 'Request body is too large' }, cors)
    const out = await api.route(req.method, path, req.headers, body)
    return sendJson(req, res, out.statusCode, out.body, cors)
  }

  const readStatic = async file => {
    try { return await readFile(file) } catch (e) {
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(e.code)) return undefined
      throw e
    }
  }

  async function handleStatic(req, res, path) {
    if (!['GET', 'HEAD'].includes(req.method)) {
      return send(req, res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Use GET or HEAD.\n')
    }
    // `path` is relative to the export: '' or '/', '/event', '/event/', '/_next/static/…'
    let file = resolve(root, `.${path || '/'}`)
    let body
    if (file === root || file.startsWith(root + sep)) {
      // Pages are index.html files in their own folders (Next.js trailingSlash);
      // serve them with or without the trailing slash.
      body = extname(file) ? await readStatic(file) : undefined
      if (!body) {
        file = join(file, 'index.html')
        body = await readStatic(file)
      }
    }
    if (!body) {
      const notFound = await readStatic(join(root, '404.html'))
      return send(req, res, 404, { 'Content-Type': types['.html'], 'Cache-Control': 'no-cache' }, notFound ?? 'Not found')
    }
    send(req, res, 200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      // Hashed build assets never change under the same name
      'Cache-Control': path.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    }, body)
  }

  return async function handle(req, res) {
    try {
      let path
      try { path = decodeURIComponent((req.url || '/').split('?')[0]) } catch { path = null }
      if (path == null || !path.startsWith('/') || path.includes('\\') || path.includes('\0')
        || path.split('/').some(part => part.startsWith('.'))) {
        return sendJson(req, res, 400, { error: 'Invalid path' })
      }

      if (path === '/healthz') return sendJson(req, res, 200, { ok: true })
      if (path === API || path.startsWith(`${API}/`)) {
        // api.route decodes each segment itself, so hand it the raw path
        const raw = (req.url || '/').split('?')[0]
        return await handleApi(req, res, raw.slice(API.length) || '/')
      }
      if (path === BASE || path.startsWith(`${BASE}/`)) return await handleStatic(req, res, path.slice(BASE.length))
      return await handleStatic(req, res, '/__not_found__')
    } catch (e) {
      console.error('Request failed:', e)
      if (res.headersSent) res.end()
      else sendJson(req, res, 500, { error: 'Internal error' })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.env.DATA_DIR || join(here, 'data'))
  mkdirSync(dataDir, { recursive: true })

  // In the container the data directory must be a mounted volume. Without one
  // the database would live in the container's own filesystem and vanish on
  // the next deploy, so refuse to start instead of losing events later.
  if (process.env.REQUIRE_DATA_VOLUME === '1' && statSync(dataDir).dev === statSync(dirname(dataDir)).dev) {
    console.error(`${dataDir} is not a mounted volume. Add persistent storage at ${dataDir} (or unset REQUIRE_DATA_VOLUME).`)
    process.exit(1)
  }

  const importToken = process.env.IMPORT_TOKEN || undefined
  if (importToken && importToken.length < 32) {
    console.error('IMPORT_TOKEN must be at least 32 characters.')
    process.exit(1)
  }

  const db = openDatabase(join(dataDir, 'scheduling.db'))
  const handle = createHandler({
    api: createApi(db),
    staticDir: process.env.STATIC_DIR || join(here, '..', 'web', 'out'),
    importToken,
  })
  const server = createServer((req, res) => { void handle(req, res) })
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
    console.log(`Scheduling is listening on ${server.address().port}${importToken ? ' (import endpoint enabled)' : ''}.`)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => { db.close(); process.exit(0) }))
  }
}
