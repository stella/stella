# Railway

This guide documents the intended Railway shape for a self-hosted stella
deployment. The goal is a template-friendly setup: separate web/API services,
managed Postgres and Redis, a private Gotenberg service, and a Railway Storage
Bucket for files. The same shape should be used for the public Railway
template.

## Services

Create these services in one Railway project:

- `web`: builds from `apps/web/Dockerfile`, public HTTP domain.
- `api`: builds from `apps/api/Dockerfile`, public HTTP domain.
- `Postgres`: Railway Postgres 18 or newer.
- `Redis`: Railway Redis or Valkey.
- `gotenberg`: image service using `gotenberg/gotenberg:8`, no public domain.
- Storage bucket, for example `stella-files`.

Point the `api` service config file at `railway/api.railway.json`. Point the
`web` service config file at `railway/web.railway.json`. Both services use the
repository root as Docker build context. Railway calls this
[config as code](https://docs.railway.com/config-as-code); custom config files
are selected in each service's settings.

The repository root must not contain a `railway.json` or `railway.toml` file.
Railway auto-discovers a config file at the repository root and applies it to
every GitHub-sourced service in a template, which would hijack each service's
build (for example, forcing `web` to build the API Dockerfile). Keeping both
service configs under `railway/` avoids that root auto-discovery. Because
serialized template config drops per-service config-file paths, the marketplace
template instead carries explicit per-service `build` settings in
`railway/template-manifest.json`. Those `build` settings must stay in sync with
the `build` blocks in each service's config file; `check:railway-template-draft`
enforces that the published template's per-service build matches the manifest.

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

| Variable                   | Source                                              | Prompt user? |
| -------------------------- | --------------------------------------------------- | ------------ |
| `DATABASE_URL`             | `${{Postgres.DATABASE_URL}}`                        | No           |
| `REDIS_URL`                | `${{Redis.REDIS_URL}}`                              | No           |
| `FRONTEND_URL`             | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`            | No           |
| `BETTER_AUTH_URL`          | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`            | No           |
| `PUBLIC_URL`               | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`            | No           |
| `BETTER_AUTH_SECRET`       | `${{secret(64, "abcdef0123456789")}}`               | No           |
| `CONTENT_ENCRYPTION_KEY`   | `${{secret(64, "abcdef0123456789")}}`               | No           |
| `SELFHOST_LOCAL_PASSWORD_AUTH` | `true`                                          | No           |
| `SELFHOST_BOOTSTRAP_TOKEN` | `${{secret(40, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}}` | No           |
| `EMAIL_PROVIDER`           | Optional: `smtp` or `ses`                           | No           |
| `SMTP_HOST`                | Optional SMTP host                                  | No           |
| `SMTP_PASSWORD`            | Optional SMTP password or API key                   | No           |
| `SMTP_PORT`                | Optional SMTP port                                  | No           |
| `SMTP_USERNAME`            | Optional SMTP username                              | No           |
| `TRANSACTIONAL_EMAIL_FROM` | Optional verified sender address                    | No           |
| `S3_ENDPOINT`              | `${{stella-files.ENDPOINT}}`                        | No           |
| `S3_BUCKET`                | `${{stella-files.BUCKET}}`                          | No           |
| `S3_REGION`                | `${{stella-files.REGION}}`                          | No           |
| `S3_ACCESS_KEY_ID`         | `${{stella-files.ACCESS_KEY_ID}}`                   | No           |
| `S3_SECRET_ACCESS_KEY`     | `${{stella-files.SECRET_ACCESS_KEY}}`               | No           |
| `GOTENBERG_URL`            | `http://${{gotenberg.RAILWAY_PRIVATE_DOMAIN}}:3000` | No           |
| `GOTENBERG_USERNAME`       | `${{gotenberg.GOTENBERG_API_BASIC_AUTH_USERNAME}}`  | No           |
| `GOTENBERG_PASSWORD`       | `${{gotenberg.GOTENBERG_API_BASIC_AUTH_PASSWORD}}`  | No           |

Template editor checklist for managed service variables:

| Service     | Variable                              | Source                                                                   | Prompt user? |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| `Postgres`  | `PGDATA`                              | `/var/lib/postgresql/data/pgdata`                                        | No           |
| `Postgres`  | `PGPORT`                              | `5432`                                                                   | No           |
| `Postgres`  | `POSTGRES_DB`                         | `railway`                                                                | No           |
| `Postgres`  | `POSTGRES_USER`                       | `postgres`                                                               | No           |
| `Postgres`  | `SSL_CERT_DAYS`                       | `820`                                                                    | No           |
| `Postgres`  | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `60`                                                                     | No           |
| `Redis`     | `REDISPORT`                           | `6379`                                                                   | No           |
| `Redis`     | `REDISUSER`                           | `default`                                                                | No           |
| `gotenberg` | `API_ENABLE_BASIC_AUTH`               | `true`                                                                   | No           |
| `gotenberg` | `GOTENBERG_API_BASIC_AUTH_USERNAME`   | `${{secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")}}` | No           |
| `gotenberg` | `GOTENBERG_API_BASIC_AUTH_PASSWORD`   | `${{secret(64, "abcdef0123456789")}}`                                    | No           |

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
- Both public domains pass `/health`.
- The marketplace overview uses `railway/template-readme.md`.

After editing the draft variables, validate that no unintended user prompts
remain:

```bash
bun run check:railway-template-draft -- --template <template-id>
```

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

The smoke checks `api` `/health`, `web` `/health`, and, when GitHub provides a
manual `expected_commit`, the exact commit reported by API `/health` and web
`/version.json`. Automatic `deployment_status` runs do not enforce a single
commit across both services because API-only and web-only changes can deploy
independently. The API and web builds both honor Railway's
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
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<template-code>?utm_medium=integration&utm_source=button&utm_campaign=stella)
```

Do not add this button to the repository until the published template code is
known and a fresh deploy from the published template has passed.

## Updating Template Users

Keep the template's source services GitHub-backed. When changes are merged to
the repository's root branch, Railway can notify projects deployed from the
template that an update is available. Users choose when to apply the update.

For stella releases, keep `docs/changelog/` current and call out database
migrations or required environment changes. Railway users should review those
notes before applying an upstream template update.

## Migrations

`railway/api.railway.json` runs `bun src/db/migrate.ts` as the API pre-deploy
command. The
migration entrypoint is included in the API runtime image and uses the same
`DATABASE_URL` as the server. It bootstraps the `stella` RLS role idempotently
before applying migrations, so a fresh managed Postgres needs no manual role
setup.

If a migration fails, Railway should not promote the API deployment. Fix the
database/config problem, then redeploy the API service.

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
