---
name: dev
description: "Start, drive and measure the local stack. `bun run agent:up` gives a checkout its own seeded, signed-in stack in one blocking command; `agent:cli` and `agent:drive` exercise it and write evidence (screenshots, browser errors, failed API calls, timings)."
---

# Local Stack

Use this whenever a change needs to be seen working, not just type-checked:
a UI change, an API behaviour, a performance claim.

## 1. Start

```bash
bun run agent:up
```

It blocks until the stack is ready and prints the web and API URLs. The
first start takes about half a minute (Docker services, migrations, and the
fixture seed while the servers boot; each step logs how long it took);
later runs reuse the running stack instantly. Interrupting `up` stops the runner it started,
and a retry joins a runner that is still starting. The runner is
`packages/scripts/src/dev-runner.ts` started detached with `--seed`:

- Worktrees get their own ports and Docker project automatically
  (`--infra-offset auto`, the default). The root checkout keeps the
  default ports. Never reset or repair a database another checkout owns.
- The seed signs in `test@stella.dev`, owner of the fixture firm, with
  matters, contacts and documents; the same data every time.
- A machine API key for that owner is minted through `/v1/api-keys`.
- State lives in `.stella-dev/` (gitignored): `runtime.json`,
  `runner.log`, `agent.env`, evidence and saved measurements.

`bun run agent:status` prints the live URLs; `bun run agent:down` stops the
stack (volumes and data survive). Leave it running while you iterate; the API
and web servers reload on save.

If `up` fails, read the tail it prints and `.stella-dev/runner.log`; fix the
cause and rerun. Do not start a second runner by hand in the same checkout.

## 2. Drive the API

```bash
bun run agent:cli -- matter list --json
bun run agent:cli -- document list --matter-id <id>
```

`agent:cli` runs the `stella` CLI from this checkout against the stack with
the minted key, so it sees the MCP registry of the code on disk. It is also
the quickest way to find ids: a matter opens at `/workspaces/<matter id>`.

## 3. Drive the web app

```bash
bun run agent:drive -- snap /workspaces /chat/new
bun run agent:drive -- run path/to/flow.ts
```

`snap` opens each path signed in, waits until `main` is visible, loading
placeholders are gone and the API is quiet, then screenshots it. `run`
imports a script that default-exports
`async ({ page, snap, webUrl, apiUrl }) => {}` (a Playwright `page`) for flows
that need clicks or typing. `snap("label", { waitFor: "<selector>" })`
records a step after the same readiness checks; name the element that
proves the step rendered, since `main` alone can be a loading screen.

Each command prints a Markdown report and exits 1 when the page showed a
problem: a browser error, a 5xx API response, a sign-in redirect, the route
error boundary, content that never finished loading, or API calls still
running after 20 s. Look at the
screenshots; a clean report with the wrong content is still wrong.

## 4. Measure

```bash
bun run agent:drive -- measure /workspaces --save before
# change the code; the dev servers reload
bun run agent:drive -- measure /workspaces --compare before
```

Reports the median of several samples after a warm-up: settle time,
DOMContentLoaded, largest contentful paint, API request count, waterfall
depth, DB queries and API payload. Timing deltas inside the sample spread are
marked as noise; do not claim them, and repeat a pair before claiming one
outside the spread. Request, query and payload counts are page totals, so a
repeated call shows up. It is a dev build, so compare runs with
each other, never with production numbers. Committed CI budgets stay with
the route-smoke suite (`/conventions-perf`).

## 5. Report evidence

When handing work back, say what you ran and what it showed: the command,
the report's findings, and the screenshot or measurement paths. A before and
after pair is the evidence for a performance claim.

In a pull request that changes what a user sees, attach the screenshots:
reference each one in the body as `![What it shows](./path.png)` and pass
`--attach ./path.png` to `gh pr create` or `gh pr edit`; `gh` uploads it and
rewrites the reference. When a change alters an existing screen, take the
"before" shots before editing it. Screenshots of the seeded stack show only
fixture data, which is what may appear in this public repository; never
attach anything else. If an upload fails, `gh` exits non-zero: retry the edit
rather than leaving a broken image.
