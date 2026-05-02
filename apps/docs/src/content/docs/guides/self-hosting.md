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
Deploy the web app as a static Vite build: follow [Vite's static deployment
guide](https://vite.dev/guide/static-deploy). On Dokploy, see [Vite
React](https://docs.dokploy.com/docs/core/vite-react): build to `./dist` and
serve that output.

```bash
cp apps/web/.env.example apps/web/.env
# edit apps/web/.env (at minimum VITE_API_URL)

bun install
```

## Frontend (web app)

The web app under `apps/web` is a Vite React SPA. From the repository root,
after `cp` / `bun install` as above, produce a production bundle with:

```bash
bun --filter @stll/web build
```

At minimum, `VITE_API_URL` must point at your public API (aligned with
`FRONTEND_URL` / `BETTER_AUTH_URL` on the API).

By default Vite writes static assets to `apps/web/dist`. Upload or serve that
folder using the steps in [Vite's static deployment
guide](https://vite.dev/guide/static-deploy). If the site is not hosted at the
domain root, set Vite `base` as described there.

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

## Prebuilt API image

Releases publish a multi-architecture image to GitHub Container Registry. You
can run that tag instead of building from source:

```bash
docker pull ghcr.io/stella/stella-api:latest
```

## Run With Docker Compose

From the repository root, pass `--env-file apps/api/.env` so Compose can read
the API environment. The API service also reads `apps/api/.env` by default.

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

- **GitHub Releases** — click *Watch → Custom → Releases* on the repo to get
  emailed when a new version ships.
- **RSS / Atom feed** — subscribe to
  [`https://github.com/stella/stella/releases.atom`](https://github.com/stella/stella/releases.atom)
  in your reader of choice, or wire it into your release tooling.
  Registry watchers like [Diun](https://crazymax.dev/diun/) can also
  monitor the published image at `ghcr.io/stella/stella-api`.
- **In-app banner** — when you set `VITE_SELFHOST="true"` in
  `apps/web/.env` and rebuild the SPA, stella checks the GitHub Releases
  API once a day and surfaces newer versions to logged-in users with a
  one-click link to the release notes. Off by default; the public
  hosted app on stll.app does not enable it.

For security-relevant fixes, watch
[Security Advisories](https://github.com/stella/stella/security/advisories)
on the repo.
