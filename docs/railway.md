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

Point the `api` service at the repository default `railway.json`. Point the
`web` service config file at `railway/web.railway.json`. Both services use the
repository root as Docker build context. Railway calls this
[config as code](https://docs.railway.com/config-as-code); custom config files
are selected in each service's settings.

## API Variables

Use Railway reference variables for services that live in the same project:

```bash
NODE_ENV=production

DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

FRONTEND_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
BETTER_AUTH_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
PUBLIC_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}

BETTER_AUTH_SECRET=${{secret(32)}}
CONTENT_ENCRYPTION_KEY=${{secret(64, "abcdef0123456789")}}

S3_ENDPOINT=<Railway bucket endpoint>
S3_BUCKET=<Railway bucket name>
S3_REGION=<Railway bucket region>
S3_CREDENTIALS_PROVIDER=env
S3_ACCESS_KEY_ID=<Railway bucket access key id>
S3_SECRET_ACCESS_KEY=<Railway bucket secret access key>

EMAIL_PROVIDER=smtp
SMTP_HOST=<smtp host>
SMTP_PORT=<smtp port>
SMTP_USERNAME=<smtp username if required>
SMTP_PASSWORD=<smtp password if required>
TRANSACTIONAL_EMAIL_FROM=noreply@example.com

GOTENBERG_URL=http://${{gotenberg.RAILWAY_PRIVATE_DOMAIN}}:3000
GOTENBERG_USERNAME=stella
GOTENBERG_PASSWORD=${{secret(32)}}

REQUIRE_PERSONAL_AI_KEY=true
FEATURE_CHAT=true
FEATURE_DESKTOP_EDITING=true
```

Do not expose Gotenberg publicly. Configure the `gotenberg` service with:

```bash
API_ENABLE_BASIC_AUTH=true
GOTENBERG_API_BASIC_AUTH_USERNAME=${{api.GOTENBERG_USERNAME}}
GOTENBERG_API_BASIC_AUTH_PASSWORD=${{api.GOTENBERG_PASSWORD}}
```

The API Docker image now honors Railway's injected `PORT` variable, with
`STELLA_API_PORT` still available as an explicit override.

For the public template, mark SMTP and storage credential variables as required
user inputs. Use Railway template variable functions for generated secrets, and
Railway reference variables for same-project services.

Template editor checklist for `api` variables:

| Variable                   | Source                                              | Prompt user? |
| -------------------------- | --------------------------------------------------- | ------------ |
| `DATABASE_URL`             | `${{Postgres.DATABASE_URL}}`                        | No           |
| `REDIS_URL`                | `${{Redis.REDIS_URL}}`                              | No           |
| `FRONTEND_URL`             | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`            | No           |
| `BETTER_AUTH_URL`          | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`            | No           |
| `PUBLIC_URL`               | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`            | No           |
| `BETTER_AUTH_SECRET`       | `${{secret(32)}}`                                   | No           |
| `CONTENT_ENCRYPTION_KEY`   | `${{secret(64, "abcdef0123456789")}}`               | No           |
| `SMTP_HOST`                | SMTP relay hostname                                 | Yes          |
| `SMTP_PORT`                | SMTP relay port                                     | Yes          |
| `SMTP_USERNAME`            | SMTP username, if required                          | Yes          |
| `SMTP_PASSWORD`            | SMTP password, if required                          | Yes          |
| `TRANSACTIONAL_EMAIL_FROM` | Verified sender address                             | Yes          |
| `S3_ENDPOINT`              | Railway bucket endpoint                             | Yes          |
| `S3_BUCKET`                | Railway bucket name                                 | Yes          |
| `S3_REGION`                | Railway bucket region                               | Yes          |
| `S3_ACCESS_KEY_ID`         | Railway bucket access key ID                        | Yes          |
| `S3_SECRET_ACCESS_KEY`     | Railway bucket secret access key                    | Yes          |
| `GOTENBERG_URL`            | `http://${{gotenberg.RAILWAY_PRIVATE_DOMAIN}}:3000` | No           |
| `GOTENBERG_USERNAME`       | `stella`                                            | No           |
| `GOTENBERG_PASSWORD`       | `${{secret(32)}}`                                   | No           |

## Web Variables

The web Dockerfile receives these as build arguments. Railway forwards matching
service variables into the Docker build, so set them before the first deploy:

```bash
PUBLIC_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
PUBLIC_APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
VITE_SELFHOST=true

VITE_FEATURE_CHAT=true
VITE_FEATURE_DESKTOP_EDITING=true
```

`PUBLIC_API_URL` maps to `VITE_API_URL`; `PUBLIC_APP_URL` maps to
`VITE_PUBLIC_APP_URL`. Because these values are baked into the web build,
changing domains requires redeploying `web`.

## Template Publishing

Build and validate the template from a clean Railway smoke project. The smoke
project should use the same service names and variable references documented
above, with source services based on the GitHub repository rather than Docker
images. GitHub-backed templates are the path Railway uses for automatic update
notifications.

Use the CLI only after the smoke project has been scrubbed of accidental
hardcoded secrets:

```bash
railway templates create \
  --project stella-railway-smoke \
  --environment production \
  --json
```

Review the unpublished template draft in Railway's template editor before
publishing. Check these items before the first publish:

- `web` source points at the public GitHub repository on the intended branch.
- `api` source points at the same repository and branch.
- `api` config path is the repository default `/railway.json`.
- `web` config path is `/railway/web.railway.json`.
- `api`, `web`, Postgres, Redis, Gotenberg, and the storage bucket all deploy
  from the template into a fresh project.
- Generated values use `secret(...)`; user-supplied credentials are prompted,
  not committed.
- Gotenberg has no public domain.
- Both public domains pass `/health`.
- The marketplace overview uses `railway/template-readme.md`.

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

`railway.json` runs `bun src/db/migrate.ts` as the API pre-deploy command. The
migration entrypoint is included in the API runtime image and uses the same
`DATABASE_URL` as the server.

If a migration fails, Railway should not promote the API deployment. Fix the
database/config problem, then redeploy the API service.

## Storage Bucket

Create a Railway Storage Bucket and copy its S3-compatible credential fields
into the API variables:

- `endpoint` -> `S3_ENDPOINT`
- `bucketName` -> `S3_BUCKET`
- `region` -> `S3_REGION`
- `accessKeyId` -> `S3_ACCESS_KEY_ID`
- `secretAccessKey` -> `S3_SECRET_ACCESS_KEY`

Keep `S3_CREDENTIALS_PROVIDER=env`. Do not put bucket credentials in the repo.

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

For the signed desktop app linking flow, keep both sides enabled:

```bash
FEATURE_DESKTOP_EDITING=true
VITE_FEATURE_DESKTOP_EDITING=true
```

Users install the signed stella desktop app, open the Railway-hosted web app,
go to **Settings -> Account -> Desktop**, and click **Connect**. The desktop
app stores trust for the exact Railway web/API origins.
