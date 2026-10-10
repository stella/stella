# @stll/mcp-apps

Browser frontends served as self-contained MCP resources by the API.

The manifest owns app directories, resource URIs and callable tools. All app
sources receive the product frontend lint policy, shared UI tokens and Oxc
React Compiler options. API-owned schemas are generated into committed
browser contracts; this package never imports API source or environment setup.

Run `bun run build` to regenerate bundles and frontend assets, and `bun run test`
to exercise the React views, bridge contracts and package ownership guards.
Regenerate API contracts first with `bun --cwd apps/api run generate:mcp-app-contracts`
from the repository root (the canonical generated-files runner orders both).

Bundle budgets live in `scripts/bundle-baseline.json`; check them with
`bun scripts/bundle-baseline.ts --mcp-apps --check`. Resource CSP requires inline
fonts, so the build omits unused sans italic faces and retains the supported
UI script ranges and shared legal-reader fonts.

Licensed under Apache-2.0.
