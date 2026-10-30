# Railway

This guide documents the intended Railway shape for a self-hosted stella
deployment. The goal is a template-friendly setup: separate web/API services,
source-built Postgres and managed Redis, a private Gotenberg service, and a Railway Storage
Bucket for files. The same shape should be used for the public Railway
template.

## Services

Create these services in one Railway project:

- `web`: builds from `apps/web/Dockerfile`, public HTTP domain.
- `api`: builds from `apps/api/Dockerfile`, public HTTP domain.
- `file-derivative-worker`: builds from `apps/api/Dockerfile`, no public domain.
  Consumes the `file-derivatives` queue (PDF previews and thumbnails); the API
  does not.
- `Postgres`: builds from `docker/postgres/Dockerfile`, with a persistent volume
  mounted at `/var/lib/postgresql` and private networking.
- `Redis`: Railway Redis or Valkey.
- `gotenberg`: image service using `gotenberg/gotenberg:8`, no public domain.
- Storage bucket, for example `stella-files`.

Point the `api` service config file at `railway/api.railway.json`. Point the
`web` service config file at `railway/web.railway.json`,
`file-derivative-worker` at `railway/file-derivative-worker.railway.json`, and
`Postgres` at `railway/postgres.railway.json`. All four services use the
repository root as Docker build context. Railway calls this
[config as code](https://docs.railway.com/config-as-code); custom config files
are selected in each service's settings.

The repository root must not contain a `railway.json` or `railway.toml` file.
Railway auto-discovers a config file at the repository root and applies it to
every GitHub-sourced service in a template, which would hijack each service's
build (for example, forcing `web` to build the API Dockerfile). Keeping the
service configs under `railway/` avoids that root auto-discovery. Because
serialized template config drops per-service config-file paths, the marketplace
template instead carries explicit per-service `build` settings in
`railway/template-manifest.json`. Those `build` settings must stay in sync with
the `build` blocks in each service's config file; `check:railway-template-draft`
enforces that the published template's per-service build matches the manifest.

## Database Initialization

Use the repository-backed Postgres service, built from
`docker/postgres/Dockerfile`. The image runs `docker/postgres/init.sql` through
the official Postgres entrypoint on an empty volume before accepting network
connections. This creates the application owner login with `NOSUPERUSER
NOBYPASSRLS`, retains the generated password, and sets up the `stella` role and
its owner membership. The API uses this demoted login through
`${{Postgres.DATABASE_URL}}` and requires it before serving requests.

Attach the Postgres volume at `/var/lib/postgresql`; set
`PGDATA=/var/lib/postgresql/18/docker`. The Postgres config requires that mount
path. The manifest declares `Postgres.volumeMountPath`, and
`check:railway-template-draft` verifies the exported service has a volume mount
at that exact path before publication. Initialization belongs to the database image entrypoint; an API
pre-deploy command does not initialize a database volume. Railway supports
[source-built database services](https://docs.railway.com/databases/build-a-database-service)
and [Dockerfile builds](https://docs.railway.com/builds/dockerfiles).

For an existing database, provision a login with `NOSUPERUSER NOBYPASSRLS`,
`CREATEROLE CREATEDB`, ownership of the application database and schemas, and
`GRANT stella TO <owner> WITH ADMIN TRUE, INHERIT FALSE, SET TRUE` before setting
`DATABASE_URL`. Run the committed migrations with that same login. The API
reports a typed startup error when the login does not meet its requirements.

## API Variables

Use Railway reference variables for services that live in the same project.
The API Docker image supplies `NODE_ENV=production` plus the self-host feature
defaults used by the Railway template, so these do not need to be template
inputs.

```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

FRONTEND_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
BETTER_AUTH_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
PUBLIC_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}

BETTER_AUTH_SECRET=${{secret(64, "abcdef0123456789")}}
CONTENT_ENCRYPTION_KEY=${{secret(64, "abcdef0123456789")}}

S3_ENDPOINT=${{stella-files.ENDPOINT}}
S3_BUCKET=${{stella-files.BUCKET}}
S3_REGION=${{stella-files.REGION}}
S3_ACCESS_KEY_ID=${{stella-files.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{stella-files.SECRET_ACCESS_KEY}}

SELFHOST_LOCAL_PASSWORD_AUTH=true
SELFHOST_BOOTSTRAP_TOKEN=${{secret(40, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}}

# Optional, only when you want email OTP sign-in and invitations.
# EMAIL_PROVIDER=smtp
# SMTP_HOST=smtp.resend.com
# SMTP_PASSWORD=<smtp password or API key>
# SMTP_PORT=587
# SMTP_USERNAME=resend
# TRANSACTIONAL_EMAIL_FROM=noreply@example.com

GOTENBERG_URL=http://${{gotenberg.RAILWAY_PRIVATE_DOMAIN}}:3000
GOTENBERG_USERNAME=${{gotenberg.GOTENBERG_API_BASIC_AUTH_USERNAME}}
GOTENBERG_PASSWORD=${{gotenberg.GOTENBERG_API_BASIC_AUTH_PASSWORD}}
```

Do not expose Gotenberg publicly. Configure the `gotenberg` service with:

```bash
API_ENABLE_BASIC_AUTH=true
GOTENBERG_API_BASIC_AUTH_USERNAME=${{secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")}}
GOTENBERG_API_BASIC_AUTH_PASSWORD=${{secret(64, "abcdef0123456789")}}
```

The API Docker image now honors Railway's injected `PORT` variable, with
`STELLA_API_PORT` still available as an explicit override.

For the public template, require no user inputs on first deploy. The template
enables self-host local password auth and generates a one-time bootstrap token
for creating the first account. SMTP/SES remains optional; operators can add it
later for email OTP sign-in, invitations, and account security emails. Use
Railway template variable functions for generated secrets and Railway reference
variables for same-project services. The repository source of truth for this
shape is `railway/template-manifest.json`.

Template editor checklist for `api` variables:

| Variable                       | Source                                                                              | Prompt user? |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------ |
| `DATABASE_URL`                 | `${{Postgres.DATABASE_URL}}`                                                        | No           |
| `REDIS_URL`                    | `${{Redis.REDIS_URL}}`                                                              | No           |
| `FRONTEND_URL`                 | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`                                            | No           |
| `BETTER_AUTH_URL`              | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`                                            | No           |
| `PUBLIC_URL`                   | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`                                            | No           |
| `BETTER_AUTH_SECRET`           | `${{secret(64, "abcdef0123456789")}}`                                               | No           |
| `CONTENT_ENCRYPTION_KEY`       | `${{secret(64, "abcdef0123456789")}}`                                               | No           |
| `SELFHOST_LOCAL_PASSWORD_AUTH` | `true`                                                                              | No           |
| `SELFHOST_BOOTSTRAP_TOKEN`     | `${{secret(40, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}}` | No           |
| `EMAIL_PROVIDER`               | Optional: `smtp` or `ses`                                                           | No           |
| `SMTP_HOST`                    | Optional SMTP host                                                                  | No           |
| `SMTP_PASSWORD`                | Optional SMTP password or API key                                                   | No           |
| `SMTP_PORT`                    | Optional SMTP port                                                                  | No           |
| `SMTP_USERNAME`                | Optional SMTP username                                                              | No           |
| `TRANSACTIONAL_EMAIL_FROM`     | Optional verified sender address                                                    | No           |
| `S3_ENDPOINT`                  | `${{stella-files.ENDPOINT}}`                                                        | No           |
| `S3_BUCKET`                    | `${{stella-files.BUCKET}}`                                                          | No           |
| `S3_REGION`                    | `${{stella-files.REGION}}`                                                          | No           |
| `S3_ACCESS_KEY_ID`             | `${{stella-files.ACCESS_KEY_ID}}`                                                   | No           |
| `S3_SECRET_ACCESS_KEY`         | `${{stella-files.SECRET_ACCESS_KEY}}`                                               | No           |
| `GOTENBERG_URL`                | `http://${{gotenberg.RAILWAY_PRIVATE_DOMAIN}}:3000`                                 | No           |
| `GOTENBERG_USERNAME`           | `${{gotenberg.GOTENBERG_API_BASIC_AUTH_USERNAME}}`                                  | No           |
| `GOTENBERG_PASSWORD`           | `${{gotenberg.GOTENBERG_API_BASIC_AUTH_PASSWORD}}`                                  | No           |

Template editor checklist for managed service variables:

| Service     | Variable                              | Source                                                                    | Prompt user? |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------- | ------------ |
| `Postgres`  | `PGDATA`                              | `/var/lib/postgresql/18/docker`                                           | No           |
| `Postgres`  | `PGPORT`                              | `5432`                                                                    | No           |
| `Postgres`  | `POSTGRES_DB`                         | `railway`                                                                 | No           |
| `Postgres`  | `POSTGRES_USER`                       | `postgres`                                                                | No           |
| `Postgres`  | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `60`                                                                      | No           |
| `Redis`     | `REDISPORT`                           | `6379`                                                                    | No           |
| `Redis`     | `REDISUSER`                           | `default`                                                                 | No           |
| `gotenberg` | `API_ENABLE_BASIC_AUTH`               | `true`                                                                    | No           |
| `gotenberg` | `GOTENBERG_API_BASIC_AUTH_USERNAME`   | `${{secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")}}` | No           |
| `gotenberg` | `GOTENBERG_API_BASIC_AUTH_PASSWORD`   | `${{secret(64, "abcdef0123456789")}}`                                     | No           |

## Web Variables

The web Dockerfile receives these as build arguments. Railway forwards matching
service variables into the Docker build, so set them before the first deploy:

```bash
PUBLIC_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
PUBLIC_APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
```

`PUBLIC_API_URL` maps to `VITE_API_URL`; `PUBLIC_APP_URL` maps to
`VITE_PUBLIC_APP_URL`. Because these values are baked into the web build,
changing domains requires redeploying `web`.

The web Dockerfile supplies the Railway self-host defaults for
`VITE_SELFHOST`, chat, contacts, knowledge templates, todos, and desktop
editing. Do not add these as template inputs unless the default changes.

## Template Publishing

Build and validate the template from a clean Railway template-source project.
The project should use the same service names and variable references documented
above, with source services based on the GitHub repository rather than Docker
images. GitHub-backed templates are the path Railway uses for automatic update
notifications.

Before generating a draft, compare the source project's service variables with
the checked-in manifest:

```bash
bun run sync:railway-template-source -- \
  --project <template-source-project-id> \
  --environment production \
  --prune
```

This syncs service variables only. It does not validate buckets, service
networking, or config files; verify those in Railway's template editor with the
checklist below. This is a dry run. To mutate the source project, add
`--apply --template-source`. Use `--template-source` only for a project
dedicated to template generation, because the manifest intentionally contains
Railway template functions such as `secret(...)`.

Use the CLI only after the template-source project's variables have been synced
from the manifest and the full template shape has been reviewed for accidental
hardcoded secrets:

```bash
railway templates create \
  --project stella-railway-template-source \
  --environment production \
  --json
```

Review the unpublished template draft in Railway's template editor before
publishing. Check these items before the first publish:

- `web` source points at the public GitHub repository on the intended branch.
- `api` source points at the same repository and branch.
- `api` config path is `/railway/api.railway.json`.
- `web` config path is `/railway/web.railway.json`.
- `Postgres` source points at the same repository and branch; it builds
  `docker/postgres/Dockerfile`, uses `/railway/postgres.railway.json`, and has a
  persistent volume at `/var/lib/postgresql`.
- Postgres initializes the demoted owner login and `stella` role before the API
  migrations and readiness check.
- No `railway.json` or `railway.toml` exists at the repository root, so Railway
  does not auto-apply a root config to every GitHub-sourced service.
- `api`, `web`, Postgres, Redis, Gotenberg, and the storage bucket all deploy
  from the template into a fresh project.
- Generated values use `secret(...)`; no deploy-time user credentials are
  required.
- `SELFHOST_LOCAL_PASSWORD_AUTH=true` and `SELFHOST_BOOTSTRAP_TOKEN` is a
  generated secret so the deployer can create the first account without SMTP.
- SMTP/SES variables are absent from the template by default and can be added
  later by operators who want email OTP sign-in or invitations.
- Gotenberg has no public domain.
- The API passes `/ready`; both public domains pass `/health`.
- The marketplace overview uses `railway/template-readme.md`.

After editing the draft variables, validate that no unintended user prompts
remain:

```bash
bun run check:railway-template-draft -- --template <template-id>
```

## Template Source Drift Guard

The template-source project must keep same-project references such as
`${{Postgres.DATABASE_URL}}` and `${{stella-files.ACCESS_KEY_ID}}` as Railway
references. Do not copy rendered values from the Railway UI into app services:
rendered database, Redis, bucket, or Gotenberg credentials can drift after a
service is recreated or a secret rotates, causing later deployments to fail
even though older deployments keep running.

`.github/workflows/railway-template-source.yml` runs a non-mutating rendered
credential check on a schedule and by manual dispatch. It verifies that the
rendered API variables match the rendered Postgres, Redis, and Gotenberg
credentials. Configure these GitHub settings:

```bash
RAILWAY_PROJECT_TOKEN=<Railway project token for the template-source project>
# Or use an account/team API token instead:
RAILWAY_API_TOKEN=<Railway account or team API token>
RAILWAY_TEMPLATE_PROJECT_ID=<template-source-project-id>
RAILWAY_TEMPLATE_ENVIRONMENT=production
```

Run the same check locally with:

```bash
bun run check:railway-template-source-runtime -- \
  --project <template-source-project-id> \
  --environment production
```

This check intentionally uses rendered variables: it catches the class of
failures where a live source project stores template functions such as
`secret(...)` directly and Railway expands each nested reference differently.
Use `sync:railway-template-source` to compare the checked-in manifest before
generating a draft, but do not apply generated-secret template functions to a
live deployable source project unless you are also reinitializing the dependent
service state from scratch.

## Source-Backed Smoke Verification

Use `.github/workflows/railway-smoke.yml` to verify the GitHub-backed Railway
shape after deployment. The workflow has two entry points:

- `deployment_status`: runs after Railway reports a successful GitHub-backed
  deployment, when `RAILWAY_SMOKE_DEPLOYMENT_ENVIRONMENT` matches the
  deployment environment.
- `workflow_dispatch`: runs manually against supplied URLs, useful before
  publishing or updating the template.

Set these GitHub repository variables for automatic checks:

```bash
RAILWAY_SMOKE_DEPLOYMENT_ENVIRONMENT=<Railway environment name>
RAILWAY_SMOKE_API_URL=https://<api-domain>
RAILWAY_SMOKE_WEB_URL=https://<web-domain>
```

For the default Railway environment, the deployment environment is usually
`production`. If the variable is unset, automatic post-deploy checks are skipped
and manual dispatch still works.

The smoke checks `api` `/ready`, `api` `/health`, `web` `/health`, and, when
GitHub provides a manual `expected_commit`, the exact commit reported by API
`/health` and web `/version.json`. Automatic `deployment_status` runs do not
enforce a single commit across both services because API-only and web-only
changes can deploy independently. The API and web builds both honor Railway's
`RAILWAY_GIT_COMMIT_SHA` so source-backed deploys can be tied back to GitHub
commits when the stricter manual check is used.

Publish or update the template with:

```bash
railway templates publish <template-id-or-code> \
  --category AI/ML \
  --description "Self-host stella with web, API, Postgres, Redis, Gotenberg, and file storage." \
  --readme-file railway/template-readme.md \
  --json
```

Marketplace metadata checklist:

- Publish from the official stella Railway workspace, not a personal workspace.
- Template name: `stella`.
- Category: `AI/ML`.
- Image: use a square transparent stella mark, not the wide repository banner.
- Description: keep it short and operational; avoid unsupported claims.
- Enable Template Queue email notifications before publishing.
- Keep private business notes out of public template copy.

After publishing, use Railway's generated template code in any README or website
button:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/stella?referralCode=2WofM4&utm_medium=integration&utm_source=button&utm_campaign=stella)
```

The published template code is `stella`; the README button above is live. Re-verify a fresh deploy from the published template after template changes.

## Updating Template Users

Keep the template's source services GitHub-backed. When changes are merged to
the repository's root branch, Railway can notify projects deployed from the
template that an update is available. Users choose when to apply the update.

For stella releases, keep `docs/changelog/` current and call out database
migrations or required environment changes. Railway users should review those
notes before applying an upstream template update.

## Migrations

`railway/api.railway.json` runs the bundled
`bun /app/apps/api/src/db/migrate.js` entrypoint as the API pre-deploy command.
The bundle is included in the API runtime image and uses the same `DATABASE_URL`
as the server. It bootstraps the `stella` RLS role idempotently before applying
migrations, so a fresh managed Postgres needs no manual role setup.

If a migration fails, Railway should not promote the API deployment. Fix the
database/config problem, then redeploy the API service.

### One-time database owner cutover

An existing template database initialized with `POSTGRES_USER=postgres` needs
an application owner login before deploying the API. The initdb role cannot
be demoted in place. Back up the database and stop the API during this cutover.

1. Change the Postgres service to build `docker/postgres/Dockerfile` from this
   repository, using `railway/postgres.railway.json`. Keep the **existing volume
   mount and `PGDATA` unchanged**: changing the data path can initialize a
   different, empty cluster. The fresh-template paths above apply to new volumes.
   Keep `POSTGRES_USER=postgres` until the command below finishes, and redeploy
   Postgres. Its entrypoint leaves an existing cluster intact.
2. Run the bundled initialization script once against the application database.
   It creates a demoted login, transfers application ownership, and configures
   the `stella` role. Before running it, confirm the Postgres service secret
   `POSTGRES_PASSWORD` contains the password from the API's existing
   `DATABASE_URL` (decoded if URL-encoded). If they differ, update that secret
   to the existing login password without printing it or putting it in a
   command argument. The cutover names the login `stella_owner` and immediately
   resets its password with `password_encryption = 'scram-sha-256'`, using the
   secret through the process environment with statement logging disabled.
   This keeps the same password even when the stored verifier is MD5: renaming
   a role clears an MD5 verifier because it includes the role name. Any other
   renamed login needs the same SCRAM password reset.

   ```sh
   railway ssh --service Postgres -- sh -ec '
     test -n "$POSTGRES_PASSWORD"
     psql -X -h /var/run/postgresql -U postgres -d "$POSTGRES_DB" \
       -v ON_ERROR_STOP=1 -v owner=postgres -v renamed_owner=stella_owner \
       -f /docker-entrypoint-initdb.d/init.sql
   '
   ```

   Run this command only once. It preserves the initdb role as a passwordless
   `NOLOGIN` maintenance role; do not use that role in `DATABASE_URL`.

3. Set Postgres `POSTGRES_USER=stella_owner` (and `PGUSER=stella_owner` if it is
   not a reference to `POSTGRES_USER`). Keep the password and database name.
   With the manifest's references, this changes `Postgres.DATABASE_URL` and the
   API's `DATABASE_URL` to use `stella_owner`. If the API has a literal URL,
   change its username explicitly, retaining the password, host, port, and
   database. Redeploy Postgres with its existing volume and data path.
4. Check the new login through the private network, then redeploy the API. Its
   pre-deploy command runs the committed migrations with that same login:

   ```sh
   railway ssh --service Postgres -- sh -ec '
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
       "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
   '
   ```

   Expect `stella_owner`, `f`, `f`; confirm migrations finish and API `/health`
   returns HTTP 200. A failed cutover must be repaired before restarting the API.

### One-time auth backfill (updating across v0.7.28)

Instances created before v0.7.28 that already have signed-in users must run a
one-time backfill when updating: the auth schema migration stops with
`issuer backfill is incomplete` until existing account rows carry their
identity provider issuer. Fresh deployments are unaffected.

This backfill is historical from v0.9.25 on. Better Auth 1.7.3 stopped writing
`account.issuer`, and the migration `20260916140000_account_issuer_nullable`
answers that by making the column nullable and adding the
`(provider_id, account_id)` identity index. These scripts and their audit
assertions still describe the older cutover, which is what an instance updating
across v0.7.28 has to pass through; they are not rerun afterwards.

Run this during a quiet window: the running pre-v0.7.28 API keeps serving
while the backfill executes, and a sign-in that lands between the backfill and
the final migration can make that migration report the guard again (rerun the
backfill and migrate) or fail that one sign-in until the redeploy completes.
Nothing is corrupted in either case.

The scripts ship in the API image. With the Railway CLI linked to the project,
run them inside the API service in a single shell so the temporary files
persist:

```sh
railway ssh --service api -- sh -c '
  set -e
  umask 177
  bun /app/apps/api/src/db/migrate.js || true
  if [ -n "${MICROSOFT_AUTH_CLIENT_ID:-}" ]; then
    bun /app/better-auth-microsoft-identity-map.js \
      --output /tmp/identity-map.json --writes-frozen
  else
    printf "{\"formatVersion\":1,\"microsoftAccounts\":[]}" > /tmp/identity-map.json
  fi
  bun /app/better-auth-migration-audit.js pre-migration \
    --baseline /tmp/baseline.json --identity-map /tmp/identity-map.json \
    --oauth-base-url "$BETTER_AUTH_URL"
  bun /app/better-auth-17-backfill.js --baseline /tmp/baseline.json \
    --identity-map /tmp/identity-map.json --batch-size 500 \
    --oauth-base-url "$BETTER_AUTH_URL" --writes-frozen
  bun /app/apps/api/src/db/migrate.js
'
```

The first migrate applies everything up to the guarded step, the identity map
and pre-migration audit record the trusted identities (Microsoft identities
are derived from stored tokens), the backfill fills the identity columns, and
the second migrate applies the remaining constraints. Then redeploy the API
service so the pre-deploy migration confirms a clean state.

## Storage Bucket

The public template provisions a Railway Storage Bucket and wires its
S3-compatible fields into the API with reference variables:

- `endpoint` -> `S3_ENDPOINT`
- `bucketName` -> `S3_BUCKET`
- `region` -> `S3_REGION`
- `accessKeyId` -> `S3_ACCESS_KEY_ID`
- `secretAccessKey` -> `S3_SECRET_ACCESS_KEY`

Manual, non-template Railway projects can copy those values by hand, but the
marketplace template should not prompt for them.

## Runtime Checks

After a deploy, check:

```bash
railway status --json
railway logs --service api --environment production --lines 100 --json
railway logs --service web --environment production --lines 100 --json
railway logs --http --service api --environment production --status ">=400" --lines 50 --json
railway logs --http --service web --environment production --status ">=400" --lines 50 --json
```

Historical failed or removed deployments in Railway's deployment history are
not active alerts by themselves. The latest deployment and active instance
status are the source of truth.

## Desktop Editing

The API and web Dockerfiles enable the signed desktop app linking flow by
default for Railway-style self-hosted deployments. Override the feature flags
only when intentionally disabling desktop editing.

Users install the signed stella desktop app, open the Railway-hosted web app,
go to **Settings -> Account -> Desktop**, and click **Connect**. The desktop
app stores trust for the exact Railway web/API origins.
