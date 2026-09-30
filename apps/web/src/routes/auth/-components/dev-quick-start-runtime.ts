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

// Bun declares hot as always present; Vite only supplies it in development.
const hot = import.meta.env.DEV ? import.meta.hot : undefined;
const hotData: unknown = hot?.data;
const restoredRuntime: unknown =
  typeof hotData === "object" &&
  hotData !== null &&
  DEV_QUICK_START_HMR_KEY in hotData
    ? hotData[DEV_QUICK_START_HMR_KEY]
    : undefined;

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
if (hot !== undefined) {
  hot.accept();
  hot.dispose((data: Record<string, unknown>) => {
    data[DEV_QUICK_START_HMR_KEY] = devQuickStartRuntime;
  });
}
