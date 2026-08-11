# stella Outlook add-in

Outlook task pane for the current message or compose draft. Standalone Bun
package: no Vite layer, no React Router. The task pane authenticates against
the stella API via a bearer token issued by better-auth's Microsoft OAuth
provider; the token arrives through an Office Dialog handoff served by
`apps/web`.

## Build flow

`manifest.template.xml` is the single source of truth. The build script
substitutes `{{TASKPANE_ORIGIN}}` / `{{API_ORIGIN}}` / `{{WEB_ORIGIN}}` /
`{{SUPPORT_URL}}` / `{{PROVIDER_NAME}}` / `{{VERSION}}` and writes
`dist/manifest.xml`. The GUID stays fixed across environments; never
regenerate it (Microsoft uses it as the identity for AppSource updates).

```sh
bun --filter @stll/outlook build                  # → dev render (localhost)
bun --filter @stll/outlook build -- --env=prod    # → prod render (stll.app)
```

Per-placeholder overrides are accepted via `STELLA_TASKPANE_ORIGIN`,
`STELLA_API_ORIGIN`, `STELLA_WEB_ORIGIN`, `STELLA_SUPPORT_URL`,
`STELLA_PROVIDER_NAME`, `STELLA_OUTLOOK_VERSION` env vars. The dev build
also rewrites the checked-in `manifest.xml` so sideload picks up template
changes without an extra step. AppSource versions must remain four-part and
at least `1.0.0.0`; increment `STELLA_OUTLOOK_VERSION` for every published
update.

For production, `STELLA_OUTLOOK_VERSION` is the release identity: the build
rejects anything other than four numeric parts, stamps that exact value into
the XML manifest, every HTML document, JavaScript, CSS, `release.json`, and
`deployment-headers.json`. JavaScript and CSS filenames include a SHA-256
content hash after the version banner, so their immutable cache entries can
never name changed bytes. Do not deploy the source directory or reconstruct
the manifest/HTML separately; publish one `apps/outlook/dist` output from one
production build.

## Local test

1. Start API and web in separate terminals:

   ```sh
   bun run dev:api
   bun run dev:web
   ```

2. Sign in at `http://localhost:3000`. The Microsoft OAuth provider must
   already be configured in better-auth (it is in production; locally you
   may need `MICROSOFT_AUTH_CLIENT_ID` /
   `MICROSOFT_AUTH_CLIENT_SECRET` env vars on the API).

3. Generate the localhost HTTPS cert (one-time):

   ```sh
   bun --filter @stll/outlook cert
   ```

   On macOS, trust it at the system keychain — user-keychain trust does
   not survive the Outlook iframe:

   ```sh
   sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain \
     apps/outlook/.certs/localhost-cert.pem
   ```

4. Start the add-in dev server:

   ```sh
   bun --filter @stll/outlook dev
   ```

   The Bun dev server watches `src/` and `public/`, rebuilds into
   `apps/outlook/dist`, and proxies `/api` to `http://localhost:3001`.

5. **Browser smoke test:** open `https://localhost:3002/taskpane.html`.
   You should see a "Sign in with Microsoft" panel on first visit. The
   panel opens the task-pane-origin `/dialog.html` bootstrap, which redirects
   to `/sign-in-outlook` on the web app. The web app runs the OAuth round-trip,
   including organization selection and two-factor authentication, then
   delivers a bearer token back via `Office.context.ui.messageParent`. Both
   sides validate the configured origin. The task pane keeps the token in
   memory only, so a reload requires a new handoff.

6. **Outlook sideload:**
   - Open <https://aka.ms/olksideload>. Microsoft opens the current
     **Add-Ins for Outlook** dialog for your signed-in mailbox.
   - **My add-ins** → **Custom Addins** → **Add a custom add-in** →
     **Add from File**.
   - Pick `apps/outlook/manifest.xml`.
   - The ribbon now shows **stella** on read + compose surfaces. Pinning the
     pane is supported; switching messages refreshes all message-scoped state.

## Auth flow

```
┌────────────────┐       ┌─────────────────┐       ┌─────────────────────────┐
│ Outlook iframe │       │ apps/outlook    │       │ apps/web                │
│  (taskpane)    │       │  /dialog.html   │       │  /sign-in-outlook       │
│                │ dialog│  same-origin    │redirect│  Microsoft OAuth        │
│  ──────────────┼──────►│  bootstrap      ├──────►│  organization + 2FA     │
│                │       └─────────────────┘       │  reads session.token    │
│                │              messageParent     │                         │
│  ◄─────────────┼─────────────────────────────────┤  posts {type, token}     │
│  keep token in memory                           └─────────────────────────┘
│  Eden + Bearer
└────────────────┘
```

No third-party cookies or separate Azure AD app are required. The Office Dialog
starts on the task pane's origin, as required by Office, then navigates to the
web origin where better-auth's existing Microsoft provider works as it does for
any browser sign-in.

## Production hosting

The production manifest expects the task pane at
`https://outlook.stll.app`. This repository builds a static release artifact
but does not deploy it. Publish one `apps/outlook/dist` directory to that
origin before distributing its `manifest.xml`; do not combine files from
different builds.

The artifact includes `deployment-headers.json`, the delivery contract for
the static host. It requires `no-cache, max-age=0, must-revalidate` on the
manifest and all HTML documents; it requires one-year immutable caching only
for content-hashed JavaScript and CSS. It also declares the strict HTML CSP
and security headers. Configure the CDN/static host to apply those rules
exactly, or run the included production server after a production build:

```sh
bun --filter @stll/outlook build -- --env=prod
bun --filter @stll/outlook serve
```

The production CSP permits only the task-pane origin, Office.js CDN,
configured Stella API/web origins, and a separately configured direct-upload
origin. Set `STELLA_UPLOAD_ORIGIN` to the exact HTTPS S3/object-storage origin
when the API returns cross-origin presigned upload URLs; leave it unset when
uploads stay on the API origin. Never use a wildcard origin.

The default CSP frame ancestors cover public Outlook, Outlook.com, its known
preview hosts, China, GCC High, and DoD Outlook on the web. For an on-premises
Exchange/OWA host or another explicit tenant host, set
`STELLA_OUTLOOK_FRAME_ANCESTORS` to a comma-separated list of exact HTTPS
origins, for example `https://mail.example.com`; the release rejects paths,
wildcards, and empty values. This setting replaces the default list, so include
every Outlook web origin that must host the add-in. Classic Outlook and Outlook
for Mac use their managed webview rather than an OWA frame.

After deployment, probe the public, non-authenticated release surface:

```sh
bun --filter @stll/outlook probe:deployment -- --origin=https://outlook.stll.app
```

The probe reads only the public manifest, release metadata, HTML documents,
response headers, and version banners at the start of static JS/CSS files. It
does not send credentials, read API data, or log response bodies. It fails if
the served version, asset references, cache policy, CSP, or security headers
do not match one artifact.

Set `OUTLOOK_ORIGIN=https://outlook.stll.app` on the API deployment. This
origin is explicit and fail-closed: without it, production API CORS and
better-auth origin checks reject task-pane requests. Custom/self-hosted
deployments must set it to the same origin used for
`STELLA_TASKPANE_ORIGIN` when rendering their manifest. Set the web build's
`VITE_OUTLOOK_ORIGIN` (or Docker `OUTLOOK_ORIGIN` build argument) to that exact
origin as well; the dialog handoff rejects every other parent origin.

The XML manifest supports read mode on Outlook for iOS and Android, plus read
and compose mode on supported desktop, web, and Mac clients. Compose mode is
not exposed on Outlook mobile because Microsoft does not support mobile
compose task panes. Browser sample data is restricted to development builds;
a production build fails closed if the Office runtime is unavailable.

V1 declares `en-US` as its only Marketplace locale. Runtime locale selection
prefers Office's display language, then the browser language, and falls back to
the declared English catalog. Adding another language requires both a complete
Outlook message catalog and matching localized manifest resources; do not
advertise a locale in Partner Center until both are present and client-tested.

V1 intentionally does not declare event-based activation or Smart Alerts.
`src/commands.ts` is an isolated Office-only runtime, checked at build time
against React/task-pane imports. If a later release needs an event runtime,
give it a separate minimal entry point and function file; do not import the
React task-pane application or share its startup path. Adding `src/events.ts`
currently fails the build until that separate entry and manifest change have
been explicitly reviewed.

## AppSource submission checklist

- Partner Center publisher name matches `<ProviderName>` in the prod
  manifest exactly.
- `<Id>` (GUID) is stable across all submissions.
- `<SupportUrl>` points at a public support/contact URL on `stll.app`.
- Privacy policy URL set in Partner Center listing (Microsoft requires it
  as a separate field — not in the manifest itself). Legal approval of that
  policy is a release gate, not a build-time substitute.
- `<AppDomains>` covers every origin the task pane talks to (currently
  `outlook.stll.app`, `my.stll.app`, `api.stll.app`).
- Validate before uploading:
  ```sh
  npx office-addin-manifest validate apps/outlook/dist/manifest.xml
  ```
- Exercise read, pinned read-item switching, compose insertion, dialog auth,
  session expiry, attachment filing, and the mobile read surface in the
  current Outlook clients before submitting the exact production artifact.
