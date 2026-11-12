// Maintenance commands, run inside the container:
//
//   docker exec <container> node server/admin.mjs add-edit-key <event_id> <hash>
//
// add-edit-key attaches an edit key to an event that has none (events made
// before editing existed). <hash> is the base64 SHA-256 of a fresh random key:
//
//   KEY=$(openssl rand -base64 24 | tr '+/' '-_'); echo "$KEY"
//   printf %s "$KEY" | openssl dgst -sha256 -binary | base64
//
// Give the key only to the creator, as
//   https://bigdogflip.com/scheduling/event/?id=<event_id>&key=<key>
// It refuses to replace a key the event already has.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi, openDatabase } from './api.mjs'

const [command, ...args] = process.argv.slice(2)
const dataDir = resolve(process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data'))

if (command === 'add-edit-key' && args.length === 2 && /^[A-Za-z0-9+/]{43}=$/.test(args[1])) {
  const db = openDatabase(join(dataDir, 'scheduling.db'))
  const ok = createApi(db).addEditKeyHash(args[0], args[1])
  db.close()
  console.log(ok ? `Edit key attached to ${args[0]}.` : `Not changed: ${args[0]} does not exist or already has an edit key.`)
  process.exit(ok ? 0 : 1)
}

console.error('Usage: node admin.mjs add-edit-key <event_id> <base64 SHA-256 of the key>')
process.exit(2)
