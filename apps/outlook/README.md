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
`dist/manifest.xml`. The GUID stays fixed across environments — never
regenerate it (Microsoft uses it as the identity for AppSource updates).

```sh
bun --filter @stll/outlook build                  # → dev render (localhost)
bun --filter @stll/outlook build -- --env=prod    # → prod render (stll.app)
```

Per-placeholder overrides are accepted via `STELLA_TASKPANE_ORIGIN`,
`STELLA_API_ORIGIN`, `STELLA_WEB_ORIGIN`, `STELLA_SUPPORT_URL`,
`STELLA_PROVIDER_NAME`, `STELLA_OUTLOOK_VERSION` env vars. The dev build
also rewrites the checked-in `manifest.xml` so sideload picks up template
changes without an extra step.

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
   `Office.context.ui.messageParent`. The token is persisted in Outlook's
   `roamingSettings` and survives task-pane reloads.

6. **Outlook sideload:**
   - Open Outlook on the web (outlook.office.com or outlook.live.com).
   - Open any email → message-header **...** → **Get Add-ins**.
   - **My add-ins** → **Add a custom add-in** → **Add from file**.
   - Pick `apps/outlook/manifest.xml`.
   - The ribbon now shows **stella** on read + compose surfaces.

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
│  roamingSettings.set(token)        │  {type, token}           │
│  Eden + Bearer                     └──────────────────────────┘
└────────────────┘
```

No third-party cookies, no Azure AD app of our own — the Office Dialog is
a real browser window same-origin with `my.stll.app`, so better-auth's
existing Microsoft provider works as it does for any browser sign-in.

## Production hosting (not in this repo)

The production task pane lives at `https://outlook.stll.app`. Hosting is
managed in `stella-infra` (Terraform-managed CloudFront + S3). The CI
upload step on the stella side is gated on that infra landing first; see
the `domain strategy` and `cross-repo deploy ordering` notes in stella's
internal docs.

## AppSource submission checklist

- Partner Center publisher name matches `<ProviderName>` in the prod
  manifest exactly.
- `<Id>` (GUID) is stable across all submissions.
- `<SupportUrl>` and `GetStarted.LearnMoreUrl` point at a public URL on
  `stll.app`.
- Privacy policy URL set in Partner Center listing (Microsoft requires it
  as a separate field — not in the manifest itself).
- `<AppDomains>` covers every origin the task pane talks to (currently
  `outlook.stll.app`, `my.stll.app`, `api.stll.app`).
- Validate before uploading:
  ```sh
  npx office-addin-manifest validate apps/outlook/dist/manifest.xml
  ```
