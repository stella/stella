# Self-hosting

stella is designed to be self-hosted. You retain full control over your data
and infrastructure.

## Overview

The repository includes a production-oriented Compose file for the stella API,
its document-processing worker, and
[Gotenberg](https://gotenberg.dev/), which stella uses for document conversion.
Supporting services are intentionally not bundled into that file: bring your
own Postgres, Redis-compatible cache, and RustFS object storage, then
point stella at them with environment variables.

This keeps the application container simple while letting operators use
existing services or a platform such as
[Dokploy](https://docs.dokploy.com/docs/core). Deploy RustFS separately using
its [production checklist](https://docs.rustfs.com/en/installation/requirement/checklists)
and connect stella through the S3 environment variables below.
For Railway, see the dedicated [Railway deployment guide](./railway.md).

Deploy the API, document-processing worker, and Gotenberg with
`docker-compose.selfhost.yml` (see below). Deploy the web app as its own
long-running server process. The web app is a TanStack Start SSR app, so
serving `apps/web/dist` as static files is not enough.

<!-- BEGIN GENERATED SELF-HOST CONTRACT -->

The production Compose contract contains exactly these services:

- `api`: HTTP API and the authoritative scheduled-job loop; readiness `/ready`.
- `document-processing-worker`: Durable document-processing queue consumer; readiness `api-ready`.
- `gotenberg`: Private authenticated document-conversion sidecar; readiness `/health`.

Its generated environment template is `deploy/selfhost/.env.example`.

Non-RDS, self-hosted and local databases must set `DB_LOAD_GATE_EBS_SIGNAL=disabled` to explicitly disable the EBS signal. The logged not_configured signal allows other health gates to govern maintenance. If neither setting is supplied, migrate fails before connecting, and background maintenance holds with an error event naming the missing configuration.
<!-- END GENERATED SELF-HOST CONTRACT -->

```bash
cp apps/web/.env.example apps/web/.env
# edit apps/web/.env (at minimum VITE_API_URL)

bun install
```

## Feature grants

Promote the image that registers a feature before setting its
`API_FEATURE_ACCESS_GRANTS`; before rolling back, set grants to `{}`.
Unknown feature IDs are dropped at startup and emit the count-only ERROR event
`feature_access.unknown_grant`. Invalid JSON or malformed grant shapes remain
fatal configuration errors.

The optional layout preview for generated views is available only in stella's
cloud; on a self-hosted instance the assistant is told the preview is
unavailable and the view is still published.

## Frontend (web app)

The web app under `apps/web` is a TanStack Start SSR app built by Vite. For a
production self-hosted build, set these web build variables in `apps/web/.env`
before building from source:

```bash
VITE_API_URL="https://api.stella.example.com"
VITE_PUBLIC_APP_URL="https://stella.example.com"
VITE_SELFHOST="true"
# Optional: use when the web origin reverse-proxies /api to the API service.
VITE_BROWSER_API_URL="https://stella.example.com/api"
```

`VITE_API_URL` must point at the public API, aligned with `PUBLIC_URL` on the
API. `VITE_PUBLIC_APP_URL` should match the public web origin, aligned with
`FRONTEND_URL` on the API. These values are baked into the web build.

When the web origin reverse-proxies `/api`, set `VITE_BROWSER_API_URL` to that
exact same-origin path and set API `BETTER_AUTH_URL` to the web origin. Keep
`PUBLIC_URL` on the direct API origin so machine OAuth issuers remain stable.
Provider callback URLs then use the web origin under `/api/auth/callback/*`.

From the repository root, after `cp` / `bun install` as above, produce a
production bundle with:

```bash
bun --filter @stll/web build
```

The build writes both server and client artifacts:

- `apps/web/dist/server/server.js`: the SSR fetch handler.
- `apps/web/dist/client/`: client assets served by the web runtime.
- `apps/web/dist/runtime.js`: the Bun runtime entry point.

Do not upload `apps/web/dist` to a static host. Run the web runtime instead:

```bash
cd apps/web
HOST=0.0.0.0 PORT=3002 bun dist/runtime.js
```

`HOST` defaults to `0.0.0.0`, `PORT` defaults to `3002`, and `/health` returns
`ok` for load balancer checks.

You can also build the web container from source:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg PUBLIC_API_URL=https://api.stella.example.com \
  --build-arg PUBLIC_BROWSER_API_URL=https://stella.example.com/api \
  --build-arg PUBLIC_APP_URL=https://stella.example.com \
  --build-arg VITE_SELFHOST=true \
  -t stella-web:local .

docker run --detach \
  --name stella-web \
  --publish 3002:3002 \
  stella-web:local
```

`PUBLIC_API_URL` maps to `VITE_API_URL`; `PUBLIC_BROWSER_API_URL` maps to
`VITE_BROWSER_API_URL`; `PUBLIC_APP_URL` maps to `VITE_PUBLIC_APP_URL`. Other
optional web build arguments are listed in `apps/web/Dockerfile` and mirror
`apps/web/.env.example`.

## Required Services

- PostgreSQL 18 or newer.
- Redis-compatible storage for queues, rate limits, and cross-instance events.
  Valkey works. Configure `maxmemory-policy noeviction` for durable
  coordination, including queues, locks, claims, counters, admission,
  publisher reservations, budgets, and MCP read fences. API and collaboration
  clients inspect `INFO memory` before durable operations and refresh policy
  after reconnect and at bounded intervals. A reported evicting policy refuses
  durable commands while caches remain available. Rate limiters retain their
  configured fallback policies. Permit `INFO memory` for the service identities
  when possible. If INFO is denied or omits the policy, the services warn and
  permit operations; operators must verify `noeviction`.
- RustFS object storage for files.
- Gotenberg for document conversion. The Compose file runs this next to the API
  on the private Docker Compose network.

RustFS is the supported self-hosted object store. Run it with TLS, persistent
local storage, and a tested backup-and-restore plan. Never use RustFS's default
`rustfsadmin` credentials. Give stella a dedicated, non-default IAM identity
restricted to its configured buckets and the object read, write, delete, and
bucket-list actions it needs. Single-node, single-disk mode has no storage
redundancy. For production data that must survive a host or disk failure, follow
RustFS's [production checklist](https://docs.rustfs.com/en/installation/requirement/checklists)
and place erasure-set drives across independent node and disk failure domains.
Set `RUSTFS_CORS_ALLOWED_ORIGINS` to the exact stella web origins so browsers
can use presigned upload and download URLs; do not use a wildcard in production.
Put the service URLs and credentials in `deploy/selfhost/.env`.

## Configure The API

Start from the generated production profile, not the local-development API
example:

```bash
cp deploy/selfhost/.env.example deploy/selfhost/.env
```

The profile is regenerated from the API schemas by `bun run
selfhost:generate`. Active blank values are operator-owned inputs.
Copy the API digest from the release manifest, and generate independent values
for each secret. For example:

```bash
openssl rand -base64 48 # BETTER_AUTH_SECRET
openssl rand -hex 32    # CONTENT_ENCRYPTION_KEY (exactly 64 hex characters)
openssl rand -base64 48 # SELFHOST_BOOTSTRAP_TOKEN
openssl rand -base64 48 # GOTENBERG_PASSWORD
```

Replace the example Postgres, Redis, object-storage, and public URL values.
When using `S3_CREDENTIALS_PROVIDER="env"`, both S3 credential variables are
required. Validate the completed file through the real production schemas
before contacting any service:

```bash
bun run selfhost:doctor
```

Time billing requires the API deployment flag `FEATURE_TIME_BILLING="true"`
and each user's enrolment in Settings > Account > Beta. The web follows that server
response; a web build variable cannot enable it.

The stock profile enables local email/password authentication and requires the
setup token when the first account is created. The web sign-up form prompts for
that token. After the first account exists, remove
`SELFHOST_BOOTSTRAP_TOKEN`; later sign-ins continue to use the account's
password. Transactional email is optional. To add email OTP, invitations, or
security mail, configure either the documented SMTP variables or SES variables
together. The template does not point at an unbundled local SMTP service.

Mock AI is available only to local development processes. The profile
sets `USE_MOCK_AI="false"` and `REQUIRE_PERSONAL_AI_KEY="true"`; organizations
provide an AI provider key in Settings. An operator may instead configure a
real instance-wide provider in `deploy/selfhost/.env`.

The self-host Compose file starts a versioned, digest-pinned Gotenberg container
next to the API. The API reads `GOTENBERG_URL` from
`deploy/selfhost/.env`; use
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

The Compose file starts the document-processing worker from the API image. The
worker stays idle when no OCR work is queued. The API owns the scheduled-job
loop and releases queued requests every
`DOCUMENT_OCR_BATCH_INTERVAL_MINUTES` (minimum 5, maximum 10080); there is no
standalone scheduler service to omit accidentally. OCR uses the CPU ONNX models
bundled in the API image. AnyDoc first inspects each PDF and queues OCR only
when the document has no usable text layer. Set
`DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES` on batch workers that should exit after
the queue stays empty.
The original PDF remains unchanged: stella stores and indexes only the derived
searchable text.

### Request budgets

Auth, API, account-attempt, and MCP quotas are configured through the validated
API environment. Omitted variables retain the defaults below; invalid values
refuse startup. Set request maxima from 1 to 1,000,000, concurrency from 1 to
10,000, windows in seconds from 1 to 604,800, and durations in milliseconds from
1,000 to 604,800,000. Changes take effect when the API restarts.

The variables change quota sizes and windows, while each limiter keeps its
identity and storage policy: authenticated users and credentials retain their
own budgets; anonymous traffic uses the applicable client or address budget.
Account-attempt limits count failures and attempts in flight; successful attempts
return their reserved slot. OTP delivery limits count requests for delivery.

The shared-address default of 1,200/minute admits concurrent sign-ins and token
exchanges from many users behind one assistant egress. Token requests reserve a slot atomically
before grant lookup and return it after successful exchanges; failed exchanges
retain their charge. Recognized grants also use the 20/minute user-and-client
budget. Anonymous registration allows 300/minute per callback set and 3,000/minute
per address, so a hosted callback can register clients for many users.

MCP allows 600/minute per bearer. Its 3,000/minute address budget counts only
failed authentication and attempts in flight. Each request reserves a slot
before verification; successful requests and verification exceptions return it. Once exhausted,
admission rejects requests at that address before credential verification until
a slot is returned or the window resets. Source-fetch work has its own 10/minute
user budget.

Every quota rejection emits a `rate_limit.rejected` structured log with `budget`,
`budget.keyKind`, and `budget.windowMs`, plus a `RateLimitRejected` counter labelled
by `budgetName`. These observations contain no caller identifiers or addresses.

| Environment variables                                                                                                            |       Default maximum |                                               Default window |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------: | -----------------------------------------------------------: |
| `RATE_LIMIT_AUTH_DEFAULT_SENSITIVE_MAX` / `RATE_LIMIT_AUTH_DEFAULT_SENSITIVE_WINDOW_SECONDS`                                     |                     3 |                                                         10 s |
| `RATE_LIMIT_AUTH_DEFAULT_EMAIL_MAX` / `RATE_LIMIT_AUTH_DEFAULT_EMAIL_WINDOW_SECONDS`                                             |                     3 |                                                         60 s |
| `RATE_LIMIT_AUTH_TWO_FACTOR_MAX` / `RATE_LIMIT_AUTH_TWO_FACTOR_WINDOW_SECONDS`                                                   |                     3 |                                                         10 s |
| `RATE_LIMIT_AUTH_GLOBAL_MAX` / `RATE_LIMIT_AUTH_GLOBAL_WINDOW_SECONDS`                                                           |                   100 |                                                         60 s |
| `RATE_LIMIT_AUTH_SIGN_IN_MAX` / `RATE_LIMIT_AUTH_SIGN_IN_WINDOW_SECONDS`                                                         |                     5 |                                                         60 s |
| `RATE_LIMIT_AUTH_SIGN_UP_MAX` / `RATE_LIMIT_AUTH_SIGN_UP_WINDOW_SECONDS`                                                         |                     3 |                                                         60 s |
| `RATE_LIMIT_AUTH_SEND_OTP_MAX` / `RATE_LIMIT_AUTH_SEND_OTP_WINDOW_SECONDS`                                                       |                     5 |                                                         60 s |
| `RATE_LIMIT_AUTH_VERIFY_OTP_MAX` / `RATE_LIMIT_AUTH_VERIFY_OTP_WINDOW_SECONDS`                                                   |                     5 |                                                         60 s |
| `RATE_LIMIT_AUTH_FORGET_PASSWORD_MAX` / `RATE_LIMIT_AUTH_FORGET_PASSWORD_WINDOW_SECONDS`                                         |                     3 |                                                         60 s |
| `RATE_LIMIT_AUTH_RESET_PASSWORD_MAX` / `RATE_LIMIT_AUTH_RESET_PASSWORD_WINDOW_SECONDS`                                           |                     5 |                                                         60 s |
| `RATE_LIMIT_AUTH_OAUTH_TOKEN_MAX` / `RATE_LIMIT_AUTH_OAUTH_TOKEN_WINDOW_SECONDS`                                                 |                    20 |                                                         60 s |
| `RATE_LIMIT_AUTH_OAUTH_AUTHORIZATION_MAX` / `RATE_LIMIT_AUTH_OAUTH_AUTHORIZATION_WINDOW_SECONDS`                                 |                    30 |                                                         60 s |
| `RATE_LIMIT_AUTH_OAUTH_CLIENT_REGISTRATION_MAX` / `RATE_LIMIT_AUTH_OAUTH_CLIENT_REGISTRATION_WINDOW_SECONDS`                     |                    30 |                                                         60 s |
| `RATE_LIMIT_AUTH_AUTH_SHARED_ADDRESS_MAX` / `RATE_LIMIT_AUTH_AUTH_SHARED_ADDRESS_WINDOW_SECONDS`                                 |                 1,200 |                                                         60 s |
| `RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_CLIENT_REGISTRATION_MAX` / `RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_CLIENT_REGISTRATION_WINDOW_SECONDS` |                   300 |                                                         60 s |
| `RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_ADDRESS_MAX` / `RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_ADDRESS_WINDOW_SECONDS`                         |                 3,000 |                                                         60 s |
| `RATE_LIMIT_API_API_MAX` / `RATE_LIMIT_API_API_DURATION_MS`                                                                      |                 1,000 |                                                    60,000 ms |
| `RATE_LIMIT_API_LEGAL_RESOLVE_MAX` / `RATE_LIMIT_API_LEGAL_RESOLVE_DURATION_MS`                                                  |                   120 |                                                    60,000 ms |
| `RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_MAX` / `RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_DURATION_MS`                              |                    20 |                                                    60,000 ms |
| `RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_MAX_CONCURRENT`                                                                          | 2 concurrent requests |                        Public sanctions search window above. |
| `RATE_LIMIT_API_SKILL_SOURCE_MAX` / `RATE_LIMIT_API_SKILL_SOURCE_DURATION_MS`                                                    |                    10 |                                                    60,000 ms |
| `RATE_LIMIT_API_UPLOAD_MAX` / `RATE_LIMIT_API_UPLOAD_DURATION_MS`                                                                |                   500 |                                                    60,000 ms |
| `RATE_LIMIT_API_MCP_TRANSPORT_MAX` / `RATE_LIMIT_API_MCP_TRANSPORT_DURATION_MS`                                                  |                   600 |                                                    60,000 ms |
| `RATE_LIMIT_API_MCP_TRANSPORT_ADDRESS_MAX` / `RATE_LIMIT_API_MCP_TRANSPORT_ADDRESS_DURATION_MS`                                  |                 3,000 |                                                    60,000 ms |
| `RATE_LIMIT_API_FOLIO_COLLAB_MAX` / `RATE_LIMIT_API_FOLIO_COLLAB_DURATION_MS`                                                    |                    30 |                                                    60,000 ms |
| `RATE_LIMIT_API_AGENT_AUTH_MAX` / `RATE_LIMIT_API_AGENT_AUTH_DURATION_MS`                                                        |                    60 |                                                    60,000 ms |
| `RATE_LIMIT_API_TRANSLATE_MAX` / `RATE_LIMIT_API_TRANSLATE_DURATION_MS`                                                          |                    30 |                                                    60,000 ms |
| `RATE_LIMIT_API_HOSTED_USAGE_WEBHOOK_MAX` / `RATE_LIMIT_API_HOSTED_USAGE_WEBHOOK_DURATION_MS`                                    |                   300 |                                                    60,000 ms |
| `RATE_LIMIT_API_DELETE_ACCOUNT_OTP_MAX` / `RATE_LIMIT_API_DELETE_ACCOUNT_OTP_DURATION_MS`                                        |                     5 |                                                    60,000 ms |
| `RATE_LIMIT_API_TWO_FACTOR_MANAGE_OTP_MAX` / `RATE_LIMIT_API_TWO_FACTOR_MANAGE_OTP_DURATION_MS`                                  |                     5 |                                                    60,000 ms |
| `RATE_LIMIT_ACCOUNT_OTP_MAX` / `RATE_LIMIT_ACCOUNT_OTP_DURATION_MS`                                                              |                    10 |                                                   900,000 ms |
| `RATE_LIMIT_ACCOUNT_DEMO_OTP_MAX` / `RATE_LIMIT_ACCOUNT_DEMO_OTP_DURATION_MS`                                                    |                     5 |                                                   900,000 ms |
| `RATE_LIMIT_ACCOUNT_PASSWORD_MAX` / `RATE_LIMIT_ACCOUNT_PASSWORD_DURATION_MS`                                                    |                    10 |                                                 3,600,000 ms |
| `RATE_LIMIT_MCP_CAPABILITY_MAX` / `RATE_LIMIT_MCP_CAPABILITY_WINDOW_MS`                                                          |                    60 |                                                    60,000 ms |
| `RATE_LIMIT_MCP_GATEWAY_MAX` / `RATE_LIMIT_MCP_GATEWAY_WINDOW_MS`                                                                |                    60 |                                                    60,000 ms |
| `RATE_LIMIT_DEMO_ACTION_MAX` / `RATE_LIMIT_DEMO_ACTION_DURATION_MS`                                                              |                   200 |                                                86,400,000 ms |
| `RATE_LIMIT_API_KEY_MACHINE_MAX` / `RATE_LIMIT_API_KEY_MACHINE_WINDOW_MS`                                                        |                   600 |                                                    60,000 ms |
| `RATE_LIMIT_API_KEY_DESKTOP_MAX` / `RATE_LIMIT_API_KEY_DESKTOP_WINDOW_MS`                                                        |                    60 |                                                    60,000 ms |
| `RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_EMAIL_MAX` / `RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_EMAIL_DURATION_MS`                        |                     3 |                                                 3,600,000 ms |
| `RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_ADDRESS_MAX` / `RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_ADDRESS_DURATION_MS`                    |                    25 |                                                10,800,000 ms |
| `RATE_LIMIT_OTP_DELIVERY_EXISTING_ACCOUNT_EMAIL_MAX`                                                                             |                    10 | Existing-account delivery uses the new-account email window. |

For example, `RATE_LIMIT_API_MCP_TRANSPORT_MAX="1200"` and
`RATE_LIMIT_API_MCP_TRANSPORT_DURATION_MS="60000"` admit up to 1,200 MCP
transport requests per credential per minute. Keep the account-failure limits
separate from broad shared-address limits when tuning a deployment.

The demo action budget resets at epoch-aligned multiples of its configured
duration; its default is one UTC day.

API-key settings configure defaults for newly minted credentials. Existing keys
retain the request ceiling and window stored with each key.

## Desktop editing

Self-hosted installs can use the signed stella desktop app without rebuilding
it and without configuration. Users install stella desktop, open **Settings → Account → Desktop** in the self-hosted web
app, and click **Connect**. The desktop app shows a local approval prompt and
stores the exact trusted web/API origin before accepting Office file handoffs.

## Database migrations

Apply SQL migrations from `apps/api/drizzle/` before running the API against a
new database, and before each application upgrade. The release image contains
the exact migration bundle for that release:

```bash
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml pull
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml run --rm --no-deps api \
  bun /app/apps/api/src/db/migrate.js
```

After migrations, run the usage policy seed explicitly inside the API image with `STELLA_USAGE_POLICY_SEEDS` set to the deployment's JSON configuration; it never runs on API startup.

<!-- usage-policy-seed-command -->

```bash
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml run --rm --no-deps api \
  bun /app/seed-usage-policies.js --results /tmp/policy-results.jsonl
```

The results file stays inside the one-off API container and is removed with it by `--rm`; capture stdout to retain the printed results.

The seed writes JSON Lines containing each policy key, its `mode` (`apply` or `dry_run`), and its `inserted`, `updated`, `unchanged`, `hidden`, `deactivated`, or `failed` outcome (with a redacted failure reason), even when its transaction rolls back; failures exit non-zero. A free policy absent from the configuration is deactivated, including when the configuration is empty (`[]`); an empty configuration hides no other policy. Add `--dry-run` to preview a configuration: the seed performs the same writes inside a transaction it then rolls back, so it reports the outcomes and exit code a real run would produce and changes nothing. Omit `--results` for a timestamped path in `/tmp`; an existing results file is never overwritten. The command prints the path and the same rows in a fenced JSON Lines block, so operators can retrieve one-off ECS task results from its CloudWatch stdout logs after the container exits.

## Container images

Releases publish multi-architecture API and web images to GitHub Container
Registry. The API image is portable and is the image used by Compose:

```bash
docker pull ghcr.io/stella/stella-api@sha256:<digest-from-release-manifest>
```

The published web image is built for the release workflow's selected hosted
target environment, so its public URLs are not portable. Self-hosted operators
must build `apps/web/Dockerfile` with their own public URLs, or run
`apps/web/dist/runtime.js` from a source checkout after building the web app.

## Run With Docker Compose

From the repository root, validate the production profile, inspect the resolved
Compose model, migrate, then start the three declared services. Run the web SSR
server separately as described above.

<!-- BEGIN GENERATED SELF-HOST RUN COMMANDS -->

```bash
bun run selfhost:doctor
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml config --quiet
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml run --rm --no-deps api \
  bun /app/apps/api/src/db/migrate.js
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml up -d
```

<!-- END GENERATED SELF-HOST RUN COMMANDS -->

`STELLA_API_IMAGE` has no default. Copy the digest-qualified API reference from
the release's `release-manifest.json`; Compose fails interpolation when it is
absent, and `selfhost:doctor` rejects tags, including version and `latest` tags.
To upgrade, copy the new digest-qualified reference into the environment, pull
it, run that image's migrations, then recreate the services.

```bash
docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml pull
```

To use a different env file, set `STELLA_API_ENV_FILE` in that file:

```bash
STELLA_API_ENV_FILE=/run/secrets/stella.env \
  docker compose --env-file /run/secrets/stella.env \
  -f docker-compose.selfhost.yml up -d
```

The API listens on port `3001` by default. To publish it on a different host
port:

```bash
STELLA_API_HOST_PORT=8080 \
  docker compose --env-file deploy/selfhost/.env \
  -f docker-compose.selfhost.yml up -d
```

## Health and readiness

- `/live` reports only that the API process can serve HTTP. Use it for a
  liveness probe.
- `/ready` checks Postgres, Redis/Valkey, object storage, authenticated
  Gotenberg health, and scheduled-job registration. It returns 503 if any
  required component is unavailable.
- `/started` reports whether readiness has passed at least once since the
  process started. It returns 503 until then and 200 afterwards for the life
  of the process, so a rollout can tell a failed start apart from a later
  dependency blip. Use it for a startup probe, never for readiness.
- `/health` is a compatibility alias for `/live` and carries the same build
  metadata used by release verification. Do not use it as a readiness probe.

Compose uses `/ready` for the API. The worker healthcheck runs only while the
worker process is alive and also requires API readiness. Queue latency and
worker error logs remain the authoritative signals that work is draining; the
healthcheck does not claim to execute a synthetic document job.

## Requirements

- PostgreSQL 18+
- Redis-compatible service (Redis or Valkey)
- RustFS object storage
- 2 GB RAM minimum

## Security canary

Operators can plant a decoy Stella machine API key in an infrastructure honey
resource. The API stores only its SHA-256 digest. If any request presents the
decoy, Stella stops it before authentication, emits an ERROR log named
`security.canary_triggered`, and returns a 403 response with the warning in both
the JSON body and `x-stella-agent-warning` header. Repeated events are
deduplicated across API replicas for five minutes.

Generate a normal-looking decoy and its digest:

```bash
STELLA_CANARY_KEY="stella_mk_$(openssl rand -hex 32)"
printf '%s' "$STELLA_CANARY_KEY" | shasum -a 256
```

Set the resulting digest as `SECURITY_CANARY_API_KEY_SHA256`. Put the plaintext
key only in a decoy secret that normal application, backup, indexing, and
support workflows never read. Configure the deployment's log platform to alert
on the event name. Never put the decoy in customer documents or normal
workspace data.

The canary is detection and optional agent disruption, not authentication or
authorization. Leaving the variable unset disables it without changing normal
requests.

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
- **In-app banner**: when you set `VITE_SELFHOST="true"` in
  `apps/web/.env` and rebuild the web app, stella checks the GitHub Releases
  API once a day and surfaces newer versions to logged-in users with a
  one-click link to the release notes. Off by default; the public
  hosted app on stll.app does not enable it.

For security-relevant fixes, watch
[Security Advisories](https://github.com/stella/stella/security/advisories)
on the repo.
