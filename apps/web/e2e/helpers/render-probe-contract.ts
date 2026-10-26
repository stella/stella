import type { RenderSnapshot } from "@stll/render-probe";

export type BrowserRenderMeasurement = {
  lastCommitAt: number;
  reset: () => number;
  read: () => {
    snapshot: RenderSnapshot;
    lastCommitAt: number;
    longTasks: number;
    longTaskMs: number;
    observedCommits: number;
    rendererCount: number;
  };
};

export type BrowserProbeOperation = { operation: "read" | "reset" };

// Playwright serializes this function without its module scope. Keep runtime
// checks inside it; the type import is erased in the browser callback.
export const readBrowserProbe = ({ operation }: BrowserProbeOperation) => {
  const isMeasurement = (value: unknown): value is BrowserRenderMeasurement =>
    typeof value === "object" &&
    value !== null &&
    "lastCommitAt" in value &&
    typeof value.lastCommitAt === "number" &&
    "read" in value &&
    typeof value.read === "function" &&
    "reset" in value &&
    typeof value.reset === "function";
  const state: unknown = Reflect.get(globalThis, "__STLL_RENDER_ACTION__");
  if (!isMeasurement(state)) {
    throw new TypeError(
      "Install the render probe before loading the measured page",
    );
  }
  const current = state.read();
  if (
    operation === "reset" &&
    (current.rendererCount === 0 || current.observedCommits === 0)
  ) {
    throw new Error(
      "The render probe has not observed a mounted React renderer",
    );
  }
  const startedAt = operation === "reset" ? state.reset() : null;
  return { ...state.read(), startedAt };
};
