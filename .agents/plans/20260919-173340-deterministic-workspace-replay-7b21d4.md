# Plan: Deterministic workspace interaction replay

## Goal

Add a deterministic, state-aware browser explorer for Stella's matter and
document workspace. It should exercise long interaction sequences that example
tests do not anticipate, preserve a compact failure trail, and replay any
failure exactly from a checked artifact or seed.

The first target is the highest-state surface: matter views, the inspector,
document loading, review facets, dialogs, history navigation, reload, and
persistent client state. The harness uses synthetic fixtures only and never
runs against production or customer data.

## Current State

- `apps/web/e2e/playwright.config.ts` already retains a Playwright trace,
  screenshot, and video on failure; `apps/web/e2e/helpers/test.ts` makes
  unexpected page and console errors fatal.
- `apps/web/e2e/helpers/workspace.ts` and
  `apps/web/e2e/helpers/document.ts` create isolated matter and DOCX fixtures;
  `global-teardown.ts` owns recovery after interrupted cleanup.
- `apps/web/e2e/helpers/clock.ts` can fix browser time. The E2E stack uses the
  development-only deterministic AI adapter, so the harness need not contact a
  model provider.
- `packages/property-testing` and `turbo.json` already establish pinned seeds,
  expanded nightly budgets, and replayable randomized failures for Bun tests.
  Browser E2E has no equivalent stateful sequence runner.
- Existing Playwright coverage is scenario-specific. It catches known flows,
  but it does not explore combinations such as view switch -> document open ->
  facet switch -> reload -> back/forward -> inspector restore.

## Decisions

- **Extend Playwright rather than introduce a new test runtime.** Playwright
  already owns browser behavior and failure artifacts. A separate UI driver
  would duplicate authentication, fixture, locator, and CI infrastructure.
- **Generate semantic actions, not coordinates or arbitrary DOM events.** Each
  action is a discriminated-union branch with an applicability probe, an
  operation, and an observable postcondition. Selection is random; execution
  remains user-shaped and debuggable.
- **Let the live surface decide which actions are valid.** The runner snapshots
  available capabilities from stable roles, route state, and owner attributes,
  then samples only applicable actions. It must never catch a failed action and
  continue as if the state were valid.
- **Persist both the seed and the resolved action trail.** A seed cheaply
  reproduces an unchanged build; the resolved trail remains authoritative when
  action weighting or capability discovery later changes.
- **Keep the harness outside production bundles.** No automation RPC, hidden
  debug endpoint, or globally exposed application store is added. Where a
  control lacks a stable semantic locator, improve its real accessibility or
  owner attribute rather than add a test-only production API.
- **Run discovery only in the nightly workflow.** A fresh seed and a broad step
  budget explore the live capability set without adding latency or a new gate
  to pull requests. Failures remain exactly replayable from their artifact.

## Scope

In scope: Chromium, authenticated web workspace, synthetic matter and DOCX,
semantic action generation, deterministic replay, bounded diagnostics,
state/runtime invariants, and a scheduled long-run job.

Out of scope: production automation hooks, real provider calls, arbitrary
pixel input, unauthenticated/public routes, native desktop window behavior,
WebKit/Firefox expansion, visual-diff baselines, performance benchmarking, and
mutations whose cleanup or idempotency is not yet modeled.

## Vertical Slices

1. **Versioned action and replay contract.** Add
   `apps/web/e2e/soak/workspace-actions.ts` with a closed `WorkspaceAction`
   union and exhaustive executor. Model selectable controls as a generic
   family/key pair discovered from owner attributes, so new matter views,
   inspector facets, and view-toolbar modes need no action-schema update. Start
   with reversible or fixture-local actions: select a discovered control, open
   the fixture document, minimize/restore the inspector, open/close a document
   dialog, reload, and browser back/forward. Add
   `apps/web/e2e/soak/replay-artifact.ts` with a Valibot-validated, versioned
   artifact containing the seed, step budget, commit, locale, viewport,
   fixture recipe, and resolved events. Unit tests under `apps/web/e2e/unit/`
   prove identical inputs choose identical actions, invalid artifacts fail at
   the boundary, and the bounded trail retains exactly the newest 512 events.

2. **State-aware Playwright runner.** Add
   `apps/web/e2e/soak/workspace-replay.playwright.spec.ts` and focused helpers
   beside it.
   Build the world through the existing workspace/document helpers, register
   deferred cleanup before browser work, fix the clock, and enter through the
   normal matter UI. Before every step, collect a sanitized state snapshot and
   the applicable action set; choose via a local seeded PRNG, execute one
   action, wait on its explicit postcondition, then collect the resulting
   state. Attach the full replay artifact through `testInfo`; on failure also
   attach the final 512-event trail and state snapshot while relying on the
   existing trace/screenshot/video policy for browser evidence. Add
   `test:e2e:soak` and a dedicated `playwright.soak.config.ts` so ordinary E2E
   sharding is unaffected.

3. **Invariants that make a sequence meaningful.** After every action, assert:
   the page has no unexpected console/page errors; the protected shell remains
   mounted; the current route belongs to the synthetic matter or an explicitly
   allowed app route; no auth redirect occurred; at most one blocking dialog
   is active; the selected inspector tab/facet is visible and internally
   consistent; a loaded document still belongs to the fixture; and reload
   preserves the server-backed document plus the declared persistent UI state.
   Track failed API responses without recording bodies, headers, query strings,
   document text, or credentials.

4. **Replay command.** Accept either
   `E2E_SOAK_SEED` plus a step count or `E2E_SOAK_REPLAY` pointing to an
   artifact. Replay consumes the recorded actions in order and fails at the
   first unavailable action with the prior/actual state snapshots; it never
   silently re-samples. Register the variables in `scripts/env-catalog.ts` and
   document one copy-paste command in `apps/web/e2e/soak/README.md`.

5. **CI discovery loop.** Add a scheduled/manual workflow modeled on the
   existing E2E stack setup, with mock AI, a production web build, Chromium,
   one worker, and a strict wall-clock budget. The scheduled job draws a fresh
   seed from its run id and runs a longer sequence. Upload replay JSON,
   Playwright trace, screenshot/video, and server logs only on failure, with
   bounded retention. Print the exact replay command in the job summary. Do not
   add the explorer to pull-request CI.

## Contracts and Invariants

- `WorkspaceAction` has a stable `type` discriminator and an exhaustive
  executor; adding an action requires an applicability rule, postcondition,
  serializer, and redaction decision.
- The seed, step limit, action weights, clock, locale, viewport, fixture
  bytes, and mock-AI mode are explicit. No action reads `Math.random()` or
  wall-clock time directly.
- A replay artifact is immutable and schema-versioned. Unknown versions and
  unknown action branches fail fast; there is no compatibility fallback.
- Every selected action was present in the recorded pre-state's applicable set.
  An empty applicable set is a harness failure with diagnostics, not success.
- Failure recording is bounded: the replay artifact may contain the full
  configured run, while the human-oriented crash trail contains at most 512
  sanitized events. No secrets, cookies, authorization data, request/response
  bodies, or document contents enter either artifact.
- Setup publishes cleanup ownership before creating mutable fixtures. Duplicate
  or interrupted cleanup converges through the existing E2E cleanup owner.
- The discovery job may find defects, but it never blocks unrelated pull
  requests.

## Verification

- Unit tests: seeded selection, weighted choice boundaries, action-map
  exhaustiveness, artifact round trip/rejection, redaction, ring-buffer bound,
  and replay divergence diagnostics.
- Browser tests: the nightly production run executes 200 actions from its run-id
  seed under a 10-minute Playwright ceiling; replaying a failure artifact uses
  the same resolved controls and checkpoints.
- Repository checks: ordinary pull-request CI validates types, unit contracts,
  environment registration, and workflow syntax without executing the browser
  explorer.

## Rollout and Recovery

Land without changing required pull-request CI. The scheduled job is the only
automated caller; calibrate its action count from observed nightly duration and
flake rate.

Recovery is removal of the scheduled job; the product runtime and persisted
schema are unchanged. Keep failed replay artifacts for the workflow's bounded
retention period, and commit only synthetic minimized trails that guard a real
defect.
