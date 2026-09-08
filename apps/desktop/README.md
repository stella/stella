## stella desktop

Tauri 2 companion app for managed Office file editing from stella.

### Local development

```bash
bun --filter @stll/desktop dev
bun --cwd apps/desktop run dev
bun run dev:desktop
```

The desktop bridge allows these origins by default:

- `http://localhost:${STELLA_WEB_PORT:-3000}`
- `http://127.0.0.1:${STELLA_WEB_PORT:-3000}`
- `https://my.stll.app`
- `https://app.stll.app`

The root `bun run dev:desktop` runner sets `STELLA_WEB_PORT`,
`STELLA_DESKTOP_VIEW_PORT`, and `STELLA_DESKTOP_BRIDGE_PORT`
automatically so multiple worktrees can coexist without port clashes.

### Testing

One search field filters clipboard history locally. The bottom-bar **Search external
registry…** action explicitly starts registry search in the same panel; typing
an identifier never switches automatically. The registry defaults to the saved
primary practice jurisdiction, or a unique matching domestic registry; ambiguous
configurations require a choice. Registry-mode typing searches after 300 ms,
without Enter. Clearing returns to local clips and cancels queued requests.
**All clips** returns without discarding the query. Up focuses clipboard or registry
cards; Down returns to the search field. Tab reaches the external-search action
(Option+Tab on macOS when full keyboard navigation is off). Input-method
composition completes before any request is sent. Sign-in preserves the query.

Use the lowest layer that reaches the failure; browser mocks do not prove
native behavior.

| Layer               | Command                                   | Covers                                                                                |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Logic and contracts | `bun --filter @stll/desktop test`         | State transitions, serialization, capability boundaries                               |
| Renderer            | `bun --filter @stll/desktop test:browser` | Real UI in Chromium and WebKit, keyboard, pointer, menus, layout; native IPC is faked |
| Native macOS        | `bun --filter @stll/desktop test:native`  | Real AppKit/WKWebView panel lifecycle                                                 |

Install renderer runtimes from `apps/desktop` with
`bunx playwright install chromium webkit`. For focused runs, append a spec
name and `--project=webkit` to `test:browser`. The runner owns port 4177 and
fails if occupied. Failed tests retain screenshots and traces in
`apps/desktop/test-results`; CI uploads these synthetic-data artifacts for
seven days. Open a trace with `bunx playwright show-trace <trace.zip>`.

The harness-free `panel_lifecycle` executable keeps AppKit on the process main
thread and never shows UI. Registry search no longer creates a second native
window; its renderer behavior and clipboard-only command permissions are tested
at their respective boundaries.

CI runs renderer tests and executes native tests on macOS. Windows currently
compiles native tests only. Neither browser WebKit nor the native lifecycle
fixture proves OS-wide hotkeys, Finder paste, runtime IPC authorization, or
live account-backed search; those require separate integration coverage.

For new interaction regressions, assert observable focus/output and reject
unexpected IPC/network activity for the entire test. Pair native-window fixes
with native coverage; verify the guard fails when the fix is reverted. Keep
automation hooks in test executables, never in ordinary debug or release
builds that can access real clipboard data.

### Configuration

Packaged builds should set these environment variables before building:

- `STELLA_DESKTOP_RELEASE_BASE_URL`
  - Base URL hosting Tauri release metadata and update artifacts (the
    channel-rooted directory containing `latest.json`)
  - Required to enable update checks in packaged builds

Runtime bridge configuration:

- Signed release builds can trust a self-hosted Stella instance at runtime:
  open **Settings → Account → Desktop** in the web app and approve the
  self-host connection prompt in stella desktop. This is the normal path for
  one-click hosted deployments.

- `STELLA_DESKTOP_ALLOWED_ORIGINS`
  - Comma-separated exact web origins allowed to call the privileged localhost bridge
  - Read at runtime; appended to the built-in defaults (loopback + hosted SPA)
  - Use this for selfhost or staging origins
- `STELLA_DESKTOP_ALLOWED_API_BASE_URLS`
  - Comma-separated exact API base URLs allowed for desktop-edit deep links
  - Read at runtime; appended to the built-in hosted API default
  - Use HTTPS URLs for selfhost or staging APIs
- `STELLA_DESKTOP_BRIDGE_PORT`
  - Optional override for the localhost bridge port during development
- `STELLA_DESKTOP_VIEW_PORT`
  - Optional override for the desktop Vite dev server during development

Example:

```bash
export STELLA_DESKTOP_RELEASE_BASE_URL="https://downloads.stll.app/desktop/prod"
bun --cwd apps/desktop run build
```

### Notes

- The bridge runs on `127.0.0.1:45901`
- The desktop view runs on `127.0.0.1:5177`
- Exact origins are required; wildcards are intentionally unsupported
- Local development does not need extra bridge configuration unless the web app is served from a non-default origin
