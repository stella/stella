import { panic } from "better-result";

import { createDevQuickStartRuntime } from "./dev-quick-start.logic";

type DevQuickStartRuntime = ReturnType<typeof createDevQuickStartRuntime>;

const DEV_QUICK_START_HMR_KEY = "devQuickStartRuntime";
const RUNTIME_METHODS = {
  getAttempt: true,
  getPhase: true,
  runSingleFlight: true,
  setAttempt: true,
  setPhase: true,
  subscribe: true,
} as const satisfies Record<keyof DevQuickStartRuntime, true>;

const isDevQuickStartRuntime = (
  value: unknown,
): value is DevQuickStartRuntime =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(RUNTIME_METHODS).every(
    (key) => typeof Reflect.get(value, key) === "function",
  );

const restoredRuntime: unknown = import.meta.hot?.data[DEV_QUICK_START_HMR_KEY];

export const devQuickStartRuntime = (() => {
  if (restoredRuntime === undefined) {
    return createDevQuickStartRuntime();
  }
  if (!isDevQuickStartRuntime(restoredRuntime)) {
    panic("Dev quick start has an invalid hot-reload runtime.");
  }
  return restoredRuntime;
})();

// Keep the flight and its attempt even when this module itself is hot-replaced.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => {
    data[DEV_QUICK_START_HMR_KEY] = devQuickStartRuntime;
  });
}
