# bigdogflip.com/scheduling: the website (web/, a Next.js static export) and
# the API (server/), served by one dependency-free Node process.
#   docker build -t scheduling .
#   docker run --rm -p 3000:3000 -v scheduling-data:/data scheduling

FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package.json web/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN yarn build

FROM node:24-alpine AS test
WORKDIR /app/server
COPY server/ ./
# A failing test fails the build, which leaves the running container in place.
RUN node --test

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data REQUIRE_DATA_VOLUME=1
COPY --from=web /app/web/out ./web/out
COPY --from=test /app/server/api.mjs /app/server/server.mjs /app/server/admin.mjs /app/server/adjectives.json ./server/
# The SQLite database lives here. Mount persistent storage at /data; the
# server refuses to start without it (see REQUIRE_DATA_VOLUME in server.mjs).
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
