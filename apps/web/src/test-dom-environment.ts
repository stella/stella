import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { createRequire } from "node:module";

type ReactScheduler = {
  unstable_IdlePriority: number;
  unstable_NormalPriority: number;
  unstable_scheduleCallback: (
    priority: number,
    callback: () => void,
  ) => unknown;
};

const isReactScheduler = (value: unknown): value is ReactScheduler =>
  typeof value === "object" &&
  value !== null &&
  "unstable_IdlePriority" in value &&
  typeof value.unstable_IdlePriority === "number" &&
  "unstable_NormalPriority" in value &&
  typeof value.unstable_NormalPriority === "number" &&
  "unstable_scheduleCallback" in value &&
  typeof value.unstable_scheduleCallback === "function";

// react-dom schedules passive effects for commits outside act() through its own
// scheduler instance; resolving it from react-dom reaches that exact queue.
export const loadReactScheduler = (): ReactScheduler => {
  const require = createRequire(import.meta.url);
  const scheduler: unknown = createRequire(require.resolve("react-dom"))(
    "scheduler",
  );
  return isReactScheduler(scheduler)
    ? scheduler
    : panic("react-dom's scheduler does not expose scheduleCallback");
};

/**
 * Remove the happy-dom globals only after React has run every scheduled task,
 * so no callback can touch `window` once it is gone. An idle-priority task
 * expires after every task queued before it and after any higher-priority
 * task those enqueue, so it runs once React's queue has drained.
 */
export const unregisterDomEnvironment = async (): Promise<void> => {
  const scheduler = loadReactScheduler();
  await new Promise<void>((resolve) => {
    scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => {
      resolve();
    });
  });
  await GlobalRegistrator.unregister();
};
