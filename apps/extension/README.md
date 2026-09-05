# Stella browser extension

Chrome-only Manifest V3 extension for approved browser actions from stella chat.
It uses the current Chrome profile, so a controlled tab shares the user's normal
signed-in website sessions. The extension does not expose cookies, raw HTML,
downloads, or arbitrary JavaScript.

## Local installation

1. Run `bun --filter @stll/extension build`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `apps/extension/.output/chrome-mv3`.
4. Open a stella app tab, then open the extension popup.
5. Choose **Allow all websites**, then **Connect current stella tab**.
6. Refresh the stella tab once after installing a new extension build.

## Trust boundary

The bridge content script runs only on the configured stella origins plus
`localhost` and `127.0.0.1`. The default list is the hosted stella origins; a
self-hosted deployment sets `WXT_STELLA_ORIGINS` at build time to a
comma-separated list of exact HTTPS origins:

```bash
WXT_STELLA_ORIGINS=https://stella.example.org bun --filter @stll/extension build
```

The popup binds one explicit tab and exact origin as the active controller.
Website access is optional, HTTPS only, and requested in a user gesture.

The controlled tab may only open or act on public HTTPS pages: plain HTTP,
loopback, private and link-local addresses, and `.local`/`.internal` hosts are
refused so an approved action never reaches an intranet or a dev server with the
user's cookies. Attachment responses in the controlled tab are blocked before
Chrome can create a download.

Snapshots read every frame and open shadow root, return interactive elements
with their link destinations, and page the visible text; long pages are read in
slices through `snapshot` with `textOffset`.

Each browser command is approved in stella chat. The user may choose, per web
session, to auto-approve page reads or every browser action.

WXT is pinned and used only as the build shell. Runtime messaging, permissions,
storage, and scripting use standard Chrome APIs and a stella-owned versioned
protocol.
