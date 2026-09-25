# Stella browser extension

Chrome-only Manifest V3 extension for approved browser actions from stella chat.
It uses the current Chrome profile, so a controlled tab shares the user's normal
signed-in website sessions. The extension does not expose cookies, raw HTML,
downloads, or arbitrary JavaScript.

## Local installation

1. Run `bun --filter @stll/extension build`. Against a local stella dev
   server, run `bun --filter @stll/extension build:dev` instead.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `apps/extension/.output/chrome-mv3` (or `chrome-mv3-dev`).
4. Open a stella app tab, then open the extension popup.
5. Choose **Allow all websites**, then **Connect current stella tab**.
6. Refresh the stella tab once after installing a new extension build.

## Trust boundary

The bridge content script runs only on the configured stella origins. The
default list is the hosted stella origins; a self-hosted deployment sets
`WXT_STELLA_ORIGINS` at build time to a comma-separated list of exact HTTPS
origins:

```bash
WXT_STELLA_ORIGINS=https://stella.example.org bun --filter @stll/extension build
```

Only development builds (`dev`, `build:dev`) and the Playwright build also
trust `http://localhost` and `http://127.0.0.1`; `build` checks that the
release manifest grants nothing on loopback or plain HTTP.

The popup binds one explicit tab and exact origin as the active controller.
Website access is optional, HTTPS only, and requested in a user gesture.

Chat reads the controlled tab. That tab is either one stella opened through
`open`, or a tab the user already has open: open the popup on that page and
choose **Use this tab with stella**, then ask about it in chat.

The controlled tab may only load public HTTPS pages, and never stella itself.
While a tab is controlled, network rules scoped to it block every page and
frame request to plain HTTP, embedded credentials, IPv6 literals, IPv4
literals in loopback, private, link-local or reserved ranges, single-label
names, `.local`/`.localhost`/`.internal` hosts and the stella origins, whether
the request comes from `open`, a click, a form post, a redirect or a
subframe. Snapshots skip frames outside this policy, and actions refuse them.
The rules judge the host name, not what it resolves to: a public name whose
DNS answer is a private address is not blocked. Attachment responses are
blocked before Chrome can create a download. The rules are lifted when control
ends.

Snapshots never include the values of password, payment-card or one-time-code
fields, or of text masked with `-webkit-text-security`, and chat cannot fill or
choose them.

Snapshots read every frame and open shadow root, return interactive elements
with their link destinations, and page the visible text; long pages are read in
slices through `snapshot` with `textOffset`.

Each browser command is approved in stella chat. The user may choose, per web
session, to auto-approve page reads or every browser action.

WXT is pinned and used only as the build shell. Runtime messaging, permissions,
storage, and scripting use standard Chrome APIs and a stella-owned versioned
protocol.
