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

## Local test

1. Start API and web in separate terminals:

   ```sh
   bun run dev:api
   bun run dev:web
   ```

2. Sign in at `http://localhost:3000`. The Microsoft OAuth provider must
   already be configured in better-auth (it is in production; locally you
   may need `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` env vars on
   the API).

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
   panel opens a dialog at `/sign-in-outlook` on the web app, which runs
   the OAuth round-trip and delivers a bearer token back via
   `Office.context.ui.messageParent`. Both sides validate the configured
   origin. The task pane keeps the token in memory only, so a reload
   requires a new handoff.

6. **Outlook sideload:**
   - Open Outlook on the web (outlook.office.com or outlook.live.com).
   - Open any email → message-header **...** → **Get Add-ins**.
   - **My add-ins** → **Add a custom add-in** → **Add from file**.
   - Pick `apps/outlook/manifest.xml`.
   - The ribbon now shows **stella** on read + compose surfaces. Pinning the
     pane is supported; switching messages refreshes all message-scoped state.

## Auth flow

```
┌────────────────┐                  ┌──────────────────────────┐
│ Outlook iframe │                  │ apps/web                 │
│  (taskpane)    │                  │  /sign-in-outlook         │
│                │  displayDialog   │                          │
│  ──────────────┼─────────────────►│  loads office.js          │
│                │                  │  authClient.signIn.social │
│                │                  │   (provider: microsoft)   │
│                │                  │  ◄── OAuth round-trip    │
│                │                  │  reads session.token      │
│                │  messageParent   │                          │
│  ◄─────────────┼──────────────────│  posts                    │
│  keep token in memory              │  {type, token}           │
│  Eden + Bearer                     └──────────────────────────┘
└────────────────┘
```

No third-party cookies or separate Azure AD app are required: the Office Dialog is
a real browser window same-origin with `my.stll.app`, so better-auth's
existing Microsoft provider works as it does for any browser sign-in.

## Production hosting

The production manifest expects the task pane at
`https://outlook.stll.app`. This repository builds the static assets and
manifest but does not deploy them. Publish `apps/outlook/dist` to that
origin before distributing the production manifest.

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
