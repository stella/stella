## stella desktop

Electrobun companion app for managed DOCX editing from stella.

### Local development

```bash
bun --cwd apps/desktop run dev
bun run dev:desktop
```

The desktop bridge only allows loopback origins by default:

- `http://localhost:${STELLA_WEB_PORT:-3000}`
- `http://127.0.0.1:${STELLA_WEB_PORT:-3000}`

The root `bun run dev:desktop` runner sets `STELLA_WEB_PORT`,
`STELLA_DESKTOP_VIEW_PORT`, and `STELLA_DESKTOP_BRIDGE_PORT`
automatically so multiple worktrees can coexist without port clashes.

### Release configuration

Packaged builds should set these environment variables before building:

- `STELLA_DESKTOP_ALLOWED_ORIGINS`
  - Comma-separated exact web origins allowed to call the privileged localhost bridge
  - Example: `https://app.stll.app,https://staging.stll.app`
  - Keep this explicit; the default loopback-only allowlist is intentional
- `STELLA_DESKTOP_BRIDGE_PORT`
  - Optional override for the localhost bridge port during development
- `STELLA_DESKTOP_VIEW_PORT`
  - Optional override for the desktop Vite dev server during development
- `STELLA_DESKTOP_RELEASE_BASE_URL`
  - Base URL hosting Electrobun release metadata and update artifacts
  - Required to enable update checks in packaged builds

Example:

```bash
export STELLA_DESKTOP_ALLOWED_ORIGINS="https://app.stll.app,https://staging.stll.app"
export STELLA_DESKTOP_RELEASE_BASE_URL="https://downloads.stll.app/desktop"
bun --cwd apps/desktop run build
```

### Notes

- The bridge runs on `127.0.0.1:45901`
- The desktop view runs on `127.0.0.1:5177`
- Exact origins are required; wildcards are intentionally unsupported
- Local development does not need extra bridge configuration unless the web app is served from a non-default origin
