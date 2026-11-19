# stella Outlook add-in

Outlook task pane for the selected message or compose draft: summarize, draft
a reply, run pre-send checks and save the email into a stella matter.
Standalone Bun package: static files, no Vite layer, no router. The task pane
signs in to the stella API as an OAuth client of its own and calls the API
with plain `fetch`.

## Sign-in

The add-in is a public OAuth 2 client (authorization code with PKCE, no
secret) described by `@stll/api-contract/outlook-client`:

- `client_id`: the client metadata document the API publishes at
  `/v1/mcp/oauth/outlook-client-metadata.json` on the issuer's origin. On an
  issuer that cannot use a metadata document (a local http API) the task pane
  registers a public client for the sign-in instead, as the mobile app does.
- `redirect_uri`: exactly `<task pane origin>/auth/callback.html`.
- `scope`: `openid offline_access stella:read stella:documents_write stella:chat`.
- `resource` (RFC 8707): `<API origin>/v1`.

```
task pane                       Office dialog                      stella API
─────────                       ─────────────                      ──────────
discover /.well-known/oauth-authorization-server ───────────────►
PKCE verifier + state (memory)
displayDialogAsync ──► /auth/start.html?authorize=<url>
                       navigates ──────────────────────────────► /oauth2/authorize
                                                                 sign-in, organization,
                                                                 consent pages
                       /auth/callback.html?code&state&iss ◄───── redirect
◄── messageParent({code, state, iss} or {error},
                  targetOrigin = task pane origin)
check origin, state, issuer
POST /oauth2/token (code + verifier, credentials omitted) ─────►
```

The dialog pages hold no secret. The start page only forwards the dialog to an
authorization request on the configured API or web origin; the callback page
forwards the authorization response fields to the task pane, addressed to its
own origin, and removes the code from its address. The task pane accepts the
message only from its own origin and only for the attempt it started (state,
and the issuer per RFC 9207).

Tokens: the access token stays in memory. The refresh token is kept in the
task-pane origin's localStorage (keyed by `Office.context.partitionKey` where
Outlook sets one), because stella rotates refresh tokens on every use; the
rotated token is stored after each refresh. A request refused with 401 is
refreshed once and retried once; a second refusal or a dead grant shows the
sign-in screen again. Sign-out revokes the refresh token at the server's
revocation endpoint and forgets the grant. Token, refresh and revocation
requests send no cookies.

The API side: the task-pane origin must be configured on the API
(`OUTLOOK_ADDIN_ORIGIN`) for CORS and the browser-origin guard, and the API
serves the client metadata document for that origin.

## Saving an email

Saving files the message as one `.eml` document through the API's ordinary
upload flow:

1. `GET /v1/properties/:workspaceId` finds the matter's file column.
2. `POST /v1/uploads/:workspaceId/presign` with `purpose: "entity_create"`,
   `mimeType: "message/rfc822"`, size and SHA-256.
3. `PUT` the bytes to the returned URL with exactly the returned headers. A
   failed PUT calls `POST /v1/uploads/:workspaceId/:uploadId/abort`.
4. `POST /v1/uploads/:workspaceId/:uploadId/finalize`. Finalize is idempotent,
   so an unanswered or busy attempt is repeated on the same upload; if it still
   does not answer, "Finish saving" finalizes that upload again instead of
   uploading the message twice.
5. `GET /v1/entities/:workspaceId/entity/:entityId` reads the file field so the
   success notice can link to the document in the web app.

In read mode the add-in sends the message exactly as the mailbox stores it
(`getAsFileAsync`, Mailbox 1.14), with every header, attachment and inline
part. Compose drafts and older hosts rebuild the message from its fields and
downloaded attachments (`src/lib/eml.ts`); inline parts are not included then.
The API turns an email file in a matter into a correspondence record and keeps
its attachments inside the file (see `apps/api/src/lib/email/inbound/README.md`,
"Uploaded email files").

## AI summary and reply draft

`POST /v1/ai/summarize` and `POST /v1/ai/draft-email` (scope `stella:chat`).
Request and response parsing comes from `@stll/api-contract`
(`truncateOutlookAIInput`, `parseOutlookAISummaryResponse`,
`parseOutlookAIDraftResponse`).

## Build flow

`manifest.template.xml` is the single source of truth. The build script
substitutes `{{TASKPANE_ORIGIN}}` / `{{API_ORIGIN}}` / `{{WEB_ORIGIN}}` /
`{{SUPPORT_URL}}` / `{{PROVIDER_NAME}}` / `{{VERSION}}` and writes
`dist/manifest.xml`, then validates it against Microsoft's manifest schemas in
`schemas/`. The GUID stays fixed across environments; never regenerate it
(Microsoft uses it as the identity for AppSource updates).

```sh
bun --filter @stll/outlook build                  # dev render (localhost)
bun --filter @stll/outlook build -- --env=prod    # prod render (stll.app)
bun --filter @stll/outlook validate:manifest dist/manifest.xml
```

Per-placeholder overrides are accepted via `STELLA_TASKPANE_ORIGIN`,
`STELLA_API_ORIGIN`, `STELLA_WEB_ORIGIN`, `STELLA_SUPPORT_URL`,
`STELLA_PROVIDER_NAME`, `STELLA_OUTLOOK_VERSION` env vars. The dev build also
rewrites the checked-in `manifest.xml` so sideload picks up template changes;
a test keeps the two in sync. AppSource versions must remain four-part and at
least `1.0.0.0`; increment `STELLA_OUTLOOK_VERSION` for every published update.

For production, `STELLA_OUTLOOK_VERSION` is the release identity: the build
rejects anything other than four numeric parts and stamps that exact value
into the XML manifest, every HTML document, JavaScript, CSS, `release.json`
and `deployment-headers.json`. JavaScript and CSS filenames include a SHA-256
content hash after the version banner, so their immutable cache entries can
never name changed bytes. Publish one `apps/outlook/dist` output from one
production build; do not reconstruct the manifest or HTML separately.

The package tests (`bun --filter @stll/outlook test`) include a production
build into a temporary directory, so the bundler, Tailwind step, manifest
render and schema validation run with every test run.

## Local development

1. Start the API and web app: `bun run dev:api` and `bun run dev:web`.
2. Generate the localhost HTTPS certificate once with
   `bun --filter @stll/outlook cert`. On macOS, trust it in the system
   keychain; user-keychain trust does not survive the Outlook webview:

   In Keychain Access, import `apps/outlook/.certs/localhost-cert.pem` into
   the System keychain and set it to Always Trust.

3. `bun --filter @stll/outlook dev` watches `src/` and `public/`, rebuilds
   into `apps/outlook/dist`, serves `https://localhost:3002` and proxies
   `/api` to `http://localhost:3001` (the https task pane cannot call a
   plain-http API directly).
4. Browser smoke test: open `https://localhost:3002/taskpane.html`. Without
   Office the sign-in screen shows; the dialog needs Outlook.
5. Sideload: open <https://aka.ms/olksideload>, then **My add-ins** →
   **Custom Addins** → **Add a custom add-in** → **Add from File** and pick
   `apps/outlook/manifest.xml`.

Against the local http API the task pane registers a public client per
sign-in, and the dialog navigates to the http API and web origins, which some
Outlook hosts refuse. Testing sign-in in real Outlook clients needs an https
API with `OUTLOOK_ADDIN_ORIGIN` set to the task-pane origin; build with
`STELLA_API_ORIGIN`, `STELLA_WEB_ORIGIN` and `STELLA_TASKPANE_ORIGIN` pointing
at it.

## Production hosting

The production manifest expects the task pane at `https://outlook.stll.app`,
the API at `https://api.stll.app` and the web app at `https://my.stll.app`.
This repository builds a static release artifact but does not deploy it.
Publish one `apps/outlook/dist` directory to the task-pane origin before
distributing its `manifest.xml`.

The artifact includes `deployment-headers.json`, the delivery contract for the
static host: `no-cache, max-age=0, must-revalidate` on the manifest and all
HTML documents (including `/auth/start.html` and `/auth/callback.html`),
one-year immutable caching only for content-hashed JavaScript and CSS, and the
strict HTML CSP and security headers. Configure the static host to apply those
rules exactly, or run the included server after a production build:

```sh
bun --filter @stll/outlook build -- --env=prod
bun --filter @stll/outlook serve
```

The production CSP permits only the task-pane origin, the Office.js CDN, the
configured stella API and web origins, and a separately configured upload
origin. Presigned upload URLs point at object storage, so set
`STELLA_UPLOAD_ORIGIN` to the exact HTTPS origin of the presigned PUT URLs;
that bucket must also allow a CORS `PUT` from the task-pane origin with the
signed headers. Never use a wildcard origin.

The default CSP frame ancestors cover public Outlook on the web, Outlook.com,
its preview hosts, China, GCC High and DoD. For an on-premises Exchange/OWA
host or another explicit tenant host, set `STELLA_OUTLOOK_FRAME_ANCESTORS` to a
comma-separated list of exact HTTPS origins; it replaces the default list.
Classic Outlook and Outlook for Mac use their own webview rather than an OWA
frame.

After deployment, probe the public, non-authenticated release surface:

```sh
bun --filter @stll/outlook probe:deployment -- --origin=https://outlook.stll.app
```

The probe reads only the public manifest, release metadata, HTML documents,
response headers and version banners. It fails if the served version, asset
references, cache policy, CSP or security headers do not match one artifact.

The manifest supports read and compose mode on desktop, web and Mac clients
with Mailbox 1.8 and DialogOrigin 1.1. It does not advertise a mobile command
surface. Browser sample data is restricted to development builds; a
production build fails closed when the Office runtime is unavailable.

The add-in declares `en-US` as its only Marketplace locale. Runtime locale
selection prefers Office's display language, then the browser language, and
falls back to English. Adding a language needs a complete message catalog and
matching localized manifest resources.

There is no event-based activation or Smart Alerts. `src/commands.ts` is an
isolated Office-only runtime, checked at build time against React and
task-pane imports; adding `src/events.ts` fails the build until a separate
entry point and manifest change are reviewed.

## Release gates

- Task pane hosted at `https://outlook.stll.app` from one production build,
  with `deployment-headers.json` applied and `probe:deployment` passing.
- API deployment: `OUTLOOK_ADDIN_ORIGIN=https://outlook.stll.app`, the client
  metadata document served, the AI routes available, and object-storage CORS
  allowing the task pane's presigned `PUT`.
- Partner Center: publisher name matches `<ProviderName>` in the prod manifest
  exactly; `<Id>` stays stable; `<SupportUrl>` points at a public support page
  on `stll.app`; `<AppDomains>` lists the task-pane, API and web origins.
- Privacy policy URL set in the Partner Center listing (a separate field, not
  in the manifest). Legal approval of that policy is a release gate, not a
  build-time substitute.
- Validate the exact artifact before uploading:
  `npx office-addin-manifest validate apps/outlook/dist/manifest.xml`.
- Real-client smoke matrix on new Outlook for Windows, classic Outlook for
  Windows, Outlook for Mac and Outlook on the web: sign-in through the dialog
  (including closing it and refusing consent), session resume after reload,
  sign-out, pinned read-item switching, saving a received message with
  attachments, saving a compose draft, insertion of a reply draft, and the
  AI summary and draft.
