# Stella browser extension

Chrome-only Manifest V3 extension for approved browser actions from stella chat.
It uses the current Chrome profile, so a controlled tab shares the user's normal
signed-in website sessions. The extension does not expose cookies, raw HTML, or
arbitrary JavaScript.

## Local installation

1. Run `bun --filter @stll/extension build`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `apps/extension/.output/chrome-mv3`.
4. Open a stella app tab, then open the extension popup.
5. Choose **Allow all websites**, then **Connect current stella tab**.
6. Refresh the stella tab once after installing a new extension build.

The bridge runs only on the hosted stella app origins, `localhost`, and
`127.0.0.1`. The popup binds one explicit tab and exact origin as the active
controller. Website access is optional and requested in a user gesture. Each
browser command still requires approval in stella chat.

WXT is pinned and used only as the build shell. Runtime messaging, permissions,
storage, and scripting use standard Chrome APIs and a stella-owned versioned
protocol.
