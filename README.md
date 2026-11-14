# Ricky Dicky's Schedule Time

A group scheduling app at <https://bigdogflip.com/scheduling/>. Someone creates
an event with candidate dates and hours, shares the link, and each person marks
when they are free.

It is a modified copy of [Crab Fit](https://github.com/GRA0007/crab.fit) by Ben
Grant (GPL-3.0, see `LICENSE`). The history before this repository existed was
carried over from `babygramps/portfolio`, where the app was served at
rickrothbart.com/scheduling.

- `web/` is the frontend, vendored from upstream commit `628f9ee`.
- `server/` is the API, a Node port of upstream's Rust API onto SQLite, and the
  process that serves the built frontend. It has no dependencies.
- `deploy/` is what runs on the server to deploy new commits.

## Changes from upstream

- `web/next.config.js`: `output: 'export'`, `basePath: '/scheduling'`, `trailingSlash`.
- Events live at `/scheduling/event/?id=<id>` (the client looks the event up)
  instead of the server-rendered `/<id>` route.
- The API is called at `/scheduling/api/` on the same site; set
  `NEXT_PUBLIC_API_URL` to override it locally.
- Server-rendered text is English; client components follow the visitor's
  language setting.
- Vercel analytics are removed. Share links point at bigdogflip.com.
- Events can be edited by their creator: creating one returns an edit key,
  kept in the browser and in a private edit link (`?id=…&key=…`).
- Rebranded as "Ricky Dicky's Schedule Time" with its own icon. The about section, stats,
  promo video, app/extension downloads, donate footer, translation prompt,
  easter egg, how-to, privacy and extension (`/create`) pages are removed.
- Passwords are hashed with scrypt instead of bcrypt.
- `web/public/llms.txt` documents the API for agents.

## Running locally

```bash
cd web && yarn install --frozen-lockfile && yarn build && cd ..
node server/server.mjs                   # http://localhost:3000/scheduling/
```

The server serves `web/out` and keeps its database in
`server/data/scheduling.db` unless `DATA_DIR` says otherwise. To work on the
frontend with hot reload, run `yarn dev` in `web/` with
`NEXT_PUBLIC_API_URL=http://localhost:3000/scheduling/api/`.

Tests:

```bash
cd server && node --test                 # API and static serving
cd web && yarn test:e2e                  # browser tests, API mocked
```

## Deployment

Production runs on Serverdude under Coolify. Coolify builds the `Dockerfile`
from `main`: it builds the frontend, runs the server tests, and produces one
image. A failed build leaves the running container in place.

Coolify application settings:

- Build pack Dockerfile, port 3000, no domain.
- Health check on `/healthz`, port 3000, host `127.0.0.1`. Coolify's default
  host `localhost` resolves to IPv6 inside the container, where the server
  does not listen, and the deploy is rolled back as unhealthy.
- Destination `app-bigdog`, network alias `scheduling`. The
  `bigdogflip-serverdude` Cloudflare tunnel sends
  `bigdogflip.com/scheduling*` to `http://scheduling:3000`.
- Persistent storage mounted at `/data`. The SQLite database lives there, and
  the server refuses to start without it so a deploy can never silently start
  from an empty database. Add this volume to the server's backups.

`rickrothbart.com/scheduling*` redirects to the same path on bigdogflip.com.

### Deploying on push

Every minute `scheduling-auto-deploy.timer` on Serverdude runs
`deploy/scheduling-auto-deploy.py`, which compares `main` on GitHub with
Coolify's latest deployment and asks Coolify's local API to build when they
differ. Coolify is not reachable from the internet, so there is no webhook.
A commit whose build failed is not retried; push a fix or press Deploy in
Coolify. To install, from `deploy/` on the server:

```bash
sudo install -m 755 scheduling-auto-deploy.py /home/servy/apps/
install -d -m 700 ~/.config/scheduling
echo 'COOLIFY_APP_UUID=<uuid from the Coolify application URL>' > ~/.config/scheduling/auto-deploy.env
sudo install -m 644 scheduling-auto-deploy.service scheduling-auto-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now scheduling-auto-deploy.timer
```

It reads the Coolify token Big Dog Flips already uses
(`~/.config/big-dog-flips/coolify-token`); set `COOLIFY_TOKEN_FILE` in the env
file to use another. Pause the timer before rolling back in Coolify, or it
will redeploy `main`.

## Maintenance

`docker exec <container> node server/admin.mjs add-edit-key …` attaches an
edit key to an event that has none; see the top of `server/admin.mjs`.

Events created on rickrothbart.com lived in DynamoDB. The
`scheduling-migrate.yml` workflow in `babygramps/portfolio` copies them over
through `POST /scheduling/api/admin/import`, which exists only while
`IMPORT_TOKEN` (32 characters or more) is set in Coolify. Remove that variable
once the migration is done.
