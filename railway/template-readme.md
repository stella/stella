# Deploy and Host stella on Railway

stella is an open-source legal workspace for matters, documents, review tables,
research, chat, and local desktop document editing. This template deploys a
self-hosted stella stack with a web app, API, Postgres, Redis, private
Gotenberg document conversion, and S3-compatible file storage.

## About Hosting stella

Hosting stella gives a legal team control over its own workspace and data while
keeping the application stack deployable as one Railway project. The web service
serves the TanStack Start SSR app, the API service handles authentication,
workspace data, document workflows, uploads, background jobs, and desktop
handoffs, and the supporting services provide database, queue, conversion, and
file-storage infrastructure.

The template uses Railway private networking for service-to-service traffic and
public HTTP domains only for the web and API services. Gotenberg is kept private
because it is an internal document conversion dependency.

## Common Use Cases

- Run a private legal workspace for matters, files, and document review.
- Self-host legal AI workflows while keeping storage under the deployer's
  control.
- Test stella against a production-like stack without assembling services by
  hand.
- Use the signed stella desktop app with a self-hosted Railway instance.
- Evaluate stella before moving to a dedicated production environment.

## Dependencies for stella Hosting

- `web`: TanStack Start SSR frontend.
- `api`: Bun/Elysia backend.
- `Postgres`: application database.
- `Redis`: queues, rate limits, and cross-instance events.
- `gotenberg`: private document conversion service.
- Storage bucket: S3-compatible object storage for uploaded files.

### Deployment Dependencies

- No external auth or email provider is required for the first login. The
  template generates a setup token; use it on the first sign-in screen to
  create the owner account.
- SMTP or SES can be added later for email OTP sign-in, invitations, and
  account security emails.
- The Railway storage bucket is provisioned by the template and wired to the
  API with reference variables.
- Generated application secrets stay in Railway variables and should not be
  copied into source control.

Use a production transactional email provider rather than a personal mailbox
SMTP account.

### Implementation Details

The API service runs database migrations as a Railway pre-deploy command. If a
migration fails, Railway should not promote the new API deployment.

The web build bakes in the public API and web origins. If Railway domains or
custom domains change later, redeploy the web service so the browser bundle uses
the new origins.

For desktop editing, install the signed stella desktop app, open the
Railway-hosted web app, go to **Settings -> Account -> Desktop**, and connect
the self-hosted instance. The desktop app stores trust for the exact web/API
origins.

## Why Deploy stella on Railway?

Railway keeps the web app, API, database, Redis, document conversion, and file
storage in one project with managed variables, logs, health checks, and
deployments. That makes stella easy to try, update, and inspect while preserving
the self-hosting model: the deployer owns the Railway project and its data.

## After Deploying

1. Open the `web` public domain.
2. Copy `SELFHOST_BOOTSTRAP_TOKEN` from the `api` service variables.
3. Create the first account with your email, a password, and the setup token.
4. Confirm the API `/health` endpoint is passing.
5. Upload a small test document to confirm storage and Gotenberg are reachable.
6. Connect the signed desktop app if local document editing is needed.

## Updating

This template is based on the GitHub repository source, so Railway can notify
deployed projects when the upstream template is updated. Review the stella
changelog before applying updates, especially when database migrations or
environment changes are included.

## Documentation

See the Railway deployment guide for operational details:
https://github.com/stella/stella/blob/main/docs/railway.md
