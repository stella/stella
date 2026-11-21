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

If the React DevTools extension already installed its hook, the probe chains
onto it.
