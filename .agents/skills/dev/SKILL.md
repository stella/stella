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
  matters, contacts and documents; the same data every time. It also
  loads public case law, including synthetic Czech decisions that fill
  several result pages (`/law/cases?country=cze&q=fiktivní`); a seeded
  stack searches it with the Postgres provider, whatever `apps/api/.env.example`
  names.
- A machine API key for that owner is minted through `/v1/api-keys`.
- State lives in `.stella-dev/` (gitignored): `runtime.json`,
  `runner.log`, `agent.env`, evidence and saved measurements.

`bun run agent:status` prints the live URLs; `bun run agent:down` stops the
stack (volumes and data survive). Leave it running while you iterate; the API
and web servers reload on save. `bun run agent:reset` recreates a worktree's
database from the seed alone (it refuses the root checkout's stack).

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

## 5. What counts as proof

A change is verified when the state it touches was driven the way a user
reaches it. Most fixes that reached main after a green check had been
exercised in an easier state than the one that broke. In a `run` flow:

- **Real input.** Click, hover and type through locators. Never set a store,
  call a handler through `page.evaluate`, or create the screen's state
  through the API when the change is in how the screen gets there. Drive the
  real sequence: hover then click, the same action twice, again after
  scrolling away or cancelling.
- **Fresh load.** Open the resulting URL directly with `page.goto` and
  `page.reload()` it. A client-side navigation hides server-render, loader
  and URL-state bugs; the URL you land on is part of the result.
- **The persisted state.** Confirm what was saved through `agent:cli` or the
  API, and reload streamed or optimistic UI to check it renders the same
  from the server.
- **The user's state.** Repeat in every state the change affects: signed out
  (`page.context().clearCookies()`), narrow (`--viewport 390x844`), `ar`,
  empty, long content.
- **The failure path.** Fail the request at the network boundary with
  `page.route` and check the message the user sees. Do not throw from inside
  the component. The report lists the injected response, and an injected 5xx
  makes the run exit 1; that is the expected result when it is the only
  finding. `page.route` sees only requests the browser makes: a request made
  during server render cannot be failed from the page, so prove that failure
  in a server-render test and say the browser state was not driven.

If the seed lacks a precondition, or the stack will not start, the change is
unverified: say which state was not driven and why. Never weaken the flow
until it passes. When a drive fails unexpectedly, run `bun run agent:status`
first; a stack that is down or belongs to another checkout is not a finding.

## 6. Report evidence

When handing work back, say what you ran and what it showed: the command,
the report's findings, and the screenshot or measurement paths. A before and
after pair is the evidence for a performance claim. Name any state from §5
that was not driven.

## 7. Screenshots in pull requests

Screenshots of changed web UI use an entry in the shared `/dev` visual
registry (`apps/web/src/routes/dev/-visual-metadata.ts`). Add a named entry
with a label and layout, then its lazy loader in `-visual-registry.tsx`; the
loader map is exhaustive over registry names. Visit `/dev?visual=<entry-name>`.
Do not add a separate playground route. The search schema and renderer derive
from the registry, and the shared section frame displays `Fixture: <label>`.
Browser tests import only metadata to keep the app graph out of their TypeScript
project.
Keep existing geometry selectors inside the fixture.

Fixture data must use the real API/contract or component prop types: import
the producing type and check literals with `satisfies`, rather than defining
a parallel shape. Add the fixture to the registry; its label/render check
runs for every entry automatically. Production route generation excludes the
visual route and fixture directory; the build guard rejects fixture modules
in emitted chunks.

`bun run agent:attach <pr number> <screenshot.png>...` is the only way to add
images to a pull request; the command guard blocks `gh ... --attach`. It
accepts an image only when it is an unaltered `agent:drive` capture taken while
the stack held nothing but seeded content: after seeding, the runner
fingerprints every table, and `agent:drive` checks the fingerprint before and
after each run. Anything created since (an upload, a new matter, a typed name,
a chat message) makes that run's captures unattachable, and the driver says so.
So does typing, pasting or dropping anything into the page in a `run` script,
even unsaved. A stack restarted while it held such content is not resealed
until `bun run agent:reset`.

- Take "before" shots before editing an existing screen.
- To show a change that needed new content, verify it for yourself, then run
  `bun run agent:reset` and capture a state reachable without creating
  anything (for example the empty dialog).
- The driver blocks requests to non-local sites, so pictures fetched from the
  web (avatars) are missing from screenshots.
- `agent:attach` appends the images to the pull request body; if an upload
  fails it exits non-zero, so run it again.
