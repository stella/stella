# @stll/render-probe

Counts what React renders on every commit, per component and by cause
(mount, props, parent, state, context).

A commit-rate budget cannot see how wide each commit is. This probe can: it
reports the components each commit rendered, the widest commit, and which of
those renders a memo boundary would have spared (`parent`).

## Use

Install the probe before React DOM or React Native loads. A renderer reads
React's DevTools hook once, when its module initialises.

```ts
import { installRenderProbe } from "@stll/render-probe";
import { formatRenderReport } from "@stll/render-probe/report";

const probe = installRenderProbe();
const { createRoot } = await import("react-dom/client");

probe.reset();
// ... drive the page ...
const snapshot = probe.snapshot();
console.log(formatRenderReport(snapshot));
```

An app build can import `@stll/render-probe/install` as its first module
instead. Drivers outside the process (Playwright, the Hermes inspector) find
the installed probe at `globalThis.__STLL_RENDER_PROBE__`.

The probe listens through one shared hook (`src/commit-hook.ts`), which
chains onto a hook the React DevTools extension or the DOM-test storm check
installed first.

## Render storms in DOM tests

Every DOM test in a workspace that lists
`packages/render-probe/src/dom-test-preload.ts` in its `bunfig.toml` (all of
them; `packages/scripts/src/dom-storm-preload-coverage.test.ts` enforces it)
runs under a storm check (`src/dom-test-guard.ts`). It counts React commits
through the DevTools hook and fails a test when

- commits drain the storm ledger's bucket: more commits than the test's
  stimuli explain (each outermost `act()` scope, a mocked response body read,
  a stream chunk, `stormStimulus()`, and time on the test's clock), or
- commits outside `act()` keep landing in eight event-loop turns without three
  idle turns in a row, during the test or right after its body returns.

At a violation the check unmounts the looping root, so a loop inside `act()`
fails the test with the components it rendered instead of hanging the run.
The check waits a few `setImmediate` turns at the end of a test that
committed, never the wall clock.

There is no opt-out. A test whose subject is a loop wraps it in
`captureStorm()`, which fails when nothing storms; a shared fake that feeds a
tree outside `act()` (a stream chunk, a socket message) calls
`stormStimulus()`:

```ts
import { captureStorm, stormStimulus } from "@stll/render-probe/dom-test";

const report = await captureStorm(async () => await renderLoop());
expect(report.violations[0]?.components[0]?.name).toBe("Loop");
```
