---
title: Self-hosting
description: Deploy stella on your own infrastructure.
---

stella is designed to be self-hosted. You retain full control over your data
and infrastructure.

## Overview

The repository includes a production-oriented Compose file for the stella API
and [Gotenberg](https://gotenberg.dev/), which stella uses for document
conversion. Supporting services are intentionally not bundled into that file:
bring your own Postgres, Redis-compatible cache, and S3-compatible object
storage, then point stella at them with environment variables.

This keeps the application container simple while letting operators use managed
services, existing self-hosted services, or a platform such as
[Dokploy](https://docs.dokploy.com/docs/core). Dokploy's
[template catalog](https://docs.dokploy.com/docs/templates) is a practical way
to deploy common dependencies such as Postgres, Valkey or Redis, and MinIO.

Deploy the API and Gotenberg with `docker-compose.selfhost.yml` (see below).
Deploy the web app as its own long-running server process. The web app is a
TanStack Start SSR app, so serving `apps/web/dist` as static files is not
enough.

```bash
cp apps/web/.env.example apps/web/.env
# edit apps/web/.env (at minimum VITE_API_URL)

bun install
```

## Frontend (web app)

The web app under `apps/web` is a TanStack Start SSR app built by Vite. For a
production self-hosted build, set these web build variables in `apps/web/.env`
before building from source:

```bash
VITE_API_URL="https://api.stella.example.com"
VITE_PUBLIC_APP_URL="https://stella.example.com"
VITE_SELFHOST="true"
```

`VITE_API_URL` must point at the public API, aligned with `BETTER_AUTH_URL` on
the API. `VITE_PUBLIC_APP_URL` should match the public web origin, aligned with
`FRONTEND_URL` on the API. These values are baked into the web build.

From the repository root, after `cp` / `bun install` as above, produce a
production bundle with:

```bash
bun --filter @stll/web build
```

The build writes both server and client artifacts:

- `apps/web/dist/server/server.js`: the SSR fetch handler.
- `apps/web/dist/client/`: client assets served by the web runtime.

Do not upload `apps/web/dist` to a static host. Run the web runtime instead:

```bash
cd apps/web
HOST=0.0.0.0 PORT=3002 bun start-runtime.js
```

`HOST` defaults to `0.0.0.0`, `PORT` defaults to `3002`, and `/health` returns
`ok` for load balancer checks.

You can also build the web container from source:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg PUBLIC_API_URL=https://api.stella.example.com \
  --build-arg PUBLIC_APP_URL=https://stella.example.com \
  --build-arg VITE_SELFHOST=true \
  -t stella-web:local .

docker run --detach \
  --name stella-web \
  --publish 3002:3002 \
  stella-web:local
```

`PUBLIC_API_URL` maps to `VITE_API_URL`; `PUBLIC_APP_URL` maps to
`VITE_PUBLIC_APP_URL`. Other optional web build arguments are listed in
`apps/web/Dockerfile` and mirror `apps/web/.env.example`.

## Required Services

- PostgreSQL 18 or newer.
- Redis-compatible storage for queues, rate limits, and cross-instance events.
  Valkey works.
- S3-compatible object storage for files. AWS S3, Cloudflare R2, and MinIO work.
- Gotenberg for document conversion. The Compose file runs this next to the API
  on the private Docker Compose network.

For Postgres, Redis/Valkey, and object storage, any self-hosted instance works
as long as the API container can reach it. Put the service URLs and credentials
in `apps/api/.env`.

## Configure The API

Start from the example API environment file:

```bash
cp apps/api/.env.example apps/api/.env
```

At minimum, set these values for your self-hosted services:

```bash
DATABASE_URL="postgres://user:password@postgres.example.internal:5432/stella"
REDIS_URL="redis://valkey.example.internal:6379"

S3_ENDPOINT="https://s3.example.com"
S3_BUCKET="stella"
S3_REGION="us-east-1"
S3_CREDENTIALS_PROVIDER="env"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
```

Also set the public application URLs and production secrets:

```bash
FRONTEND_URL="https://stella.example.com"
BETTER_AUTH_URL="https://api.stella.example.com"
BETTER_AUTH_SECRET="replace-with-at-least-32-random-characters"
EMAIL_PROVIDER="smtp"
TRANSACTIONAL_EMAIL_FROM="noreply@example.com"
GOTENBERG_URL="http://gotenberg:3000"
GOTENBERG_USERNAME="replace-with-a-username"
GOTENBERG_PASSWORD="replace-with-a-password"
```

The self-host Compose file starts the stock `gotenberg/gotenberg:8` container
next to the API. The API reads `GOTENBERG_URL` from `apps/api/.env`; use
`http://gotenberg:3000` for Docker Compose because `localhost` inside the API
container means the API container itself. Services on the private Compose
network can reach Gotenberg at `gotenberg:3000` ([Gotenberg
installation](https://gotenberg.dev/docs/getting-started/installation)).
The same `GOTENBERG_USERNAME` and `GOTENBERG_PASSWORD` values are passed to
Gotenberg as basic-auth credentials, and the API uses them on conversion
requests.

Do not expose Gotenberg to the public internet. Gotenberg's installation guide
recommends treating it like a database: keep it behind your firewall. The
self-host Compose file intentionally does not publish a `ports` entry for the
Gotenberg service.

## Database migrations

Apply SQL migrations from `apps/api/drizzle/` before running the API against a
new database. Use [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview) and
the [migrations](https://orm.drizzle.team/docs/migrations) documentation. With
`DATABASE_URL` set (for example in `apps/api/.env`):

```bash
cd apps/api
bun drizzle-kit migrate
```

## Container images

Releases publish a multi-architecture API image to GitHub Container Registry.
You can run a release tag instead of building the API from source:

```bash
docker pull ghcr.io/stella/stella-api:vX.Y.Z
```

Only the API image is published by the release workflow today. Build the web
image from `apps/web/Dockerfile`, or run `apps/web/start-runtime.js` from a
source checkout after `bun --filter @stll/web build`.

## Run With Docker Compose

From the repository root, pass `--env-file apps/api/.env` so Compose can read
the API environment. The API service also reads `apps/api/.env` by default.
This Compose file starts the API and Gotenberg only; run the web SSR server
separately as described above.

```bash
docker compose --env-file apps/api/.env -f docker-compose.selfhost.yml up -d --build
```

To use a different env file, set `STELLA_API_ENV_FILE` in that file:

```bash
STELLA_API_ENV_FILE=.env.local docker compose --env-file .env.local -f docker-compose.selfhost.yml up -d --build
```

The API listens on port `3001` by default. To publish it on a different host
port:

```bash
STELLA_API_HOST_PORT=8080 docker compose --env-file apps/api/.env -f docker-compose.selfhost.yml up -d --build
```

## Requirements

- PostgreSQL 18+
- Redis-compatible service (Redis or Valkey)
- S3-compatible object storage (AWS S3, MinIO, Cloudflare R2)
- 2 GB RAM minimum

## Stay informed about updates

stella publishes a [GitHub Release](https://github.com/stella/stella/releases)
for every version. Three ways to keep up with it:

- **GitHub Releases** — click _Watch → Custom → Releases_ on the repo to get
  emailed when a new version ships.
- **RSS / Atom feed** — subscribe to
  [`https://github.com/stella/stella/releases.atom`](https://github.com/stella/stella/releases.atom)
  in your reader of choice, or wire it into your release tooling.
  Registry watchers like [Diun](https://crazymax.dev/diun/) can also
  monitor the published image at `ghcr.io/stella/stella-api`.
- **In-app banner** — when you set `VITE_SELFHOST="true"` in
  `apps/web/.env` and rebuild the web app, stella checks the GitHub Releases
  API once a day and surfaces newer versions to logged-in users with a
  one-click link to the release notes. Off by default; the public
  hosted app on stll.app does not enable it.

For security-relevant fixes, watch
[Security Advisories](https://github.com/stella/stella/security/advisories)
on the repo.
