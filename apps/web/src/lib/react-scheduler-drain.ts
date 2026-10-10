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
 * Resolve once React's scheduler has run every task queued so far. An
 * idle-priority task expires after every task queued before it and after any
 * higher-priority task those enqueue, so it runs once the queue has drained.
 * The scheduler exposes no queue inspection, so a barrier task is the drain.
 */
export const drainReactScheduler = async (): Promise<void> => {
  const scheduler = loadReactScheduler();
  await new Promise<void>((resolve) => {
    scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => {
      resolve();
    });
  });
};
