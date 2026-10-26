/// <reference lib="dom" />
import "../../../../packages/render-probe/src/install";
import { installRenderProbe } from "../../../../packages/render-probe/src/probe";
import type { BrowserRenderMeasurement } from "./render-probe-contract";

const probe = installRenderProbe();

let startedAt = Date.now();
let longTasks = 0;
let longTaskMs = 0;
let observedCommits = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (performance.timeOrigin + entry.startTime >= startedAt) {
      longTasks += 1;
      longTaskMs += entry.duration;
    }
  }
});
observer.observe({ type: "longtask" });

const state: BrowserRenderMeasurement = {
  lastCommitAt: 0,
  reset: () => {
    probe.reset();
    observer.takeRecords();
    startedAt = Date.now();
    state.lastCommitAt = startedAt;
    longTasks = 0;
    longTaskMs = 0;
    return startedAt;
  },
  read: () => ({
    snapshot: probe.snapshot(),
    lastCommitAt: state.lastCommitAt,
    longTasks,
    longTaskMs,
    observedCommits,
    rendererCount: rendererCount(),
  }),
};
Reflect.set(globalThis, "__STLL_RENDER_ACTION__", state);

// Refresh wraps these callbacks itself. Preserve its receiver and arguments;
// a frame-sampled commit counter would lose the actual end of the action.
const hook: unknown = Reflect.get(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
if (typeof hook !== "object" || hook === null) {
  throw new TypeError(
    "The render probe did not install the React DevTools hook",
  );
}
const previousCommit: unknown = Reflect.get(hook, "onCommitFiberRoot");
if (typeof previousCommit !== "function") {
  throw new TypeError("The render probe did not install a commit callback");
}
Reflect.set(hook, "onCommitFiberRoot", (...args: unknown[]) => {
  Reflect.apply(previousCommit, hook, args);
  observedCommits += 1;
  state.lastCommitAt = Date.now();
});

const rendererCount = () => {
  const renderers: unknown = Reflect.get(hook, "renderers");
  return renderers instanceof Map ? renderers.size : 0;
};
