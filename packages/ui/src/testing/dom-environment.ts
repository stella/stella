import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { createRequire } from "node:module";
import { setImmediate as nextMacrotask } from "node:timers/promises";

type ReactScheduler = {
  unstable_IdlePriority: number;
  unstable_scheduleCallback: (
    priority: number,
    callback: () => void,
  ) => unknown;
};

// Every scheduled task carries an id from one counter, in scheduling order.
const taskId = (task: unknown): number =>
  typeof task === "object" &&
  task !== null &&
  "id" in task &&
  typeof task.id === "number"
    ? task.id
    : panic("React's scheduler returned a task without a numeric id");

const isReactScheduler = (value: unknown): value is ReactScheduler =>
  typeof value === "object" &&
  value !== null &&
  "unstable_IdlePriority" in value &&
  typeof value.unstable_IdlePriority === "number" &&
  "unstable_scheduleCallback" in value &&
  typeof value.unstable_scheduleCallback === "function";

// react-dom schedules work for updates outside act() through its own scheduler
// instance; resolving it from react-dom reaches that exact queue.
const loadReactScheduler = (): ReactScheduler => {
  const require = createRequire(import.meta.url);
  const scheduler: unknown = createRequire(require.resolve("react-dom"))(
    "scheduler",
  );
  return isReactScheduler(scheduler)
    ? scheduler
    : panic("react-dom's scheduler does not expose scheduleCallback");
};

/**
 * Resolve once React's scheduler has run every task queued so far and every
 * task that work enqueues. An idle-priority barrier runs after every task
 * queued before it, but not after an idle task enqueued later, so the drain
 * repeats barriers until one follows the previous with no task scheduled in
 * between. Each barrier is followed by a full macrotask turn, so work that
 * schedules a task from a promise continuation has done so before the next
 * barrier takes its id.
 */
const drainReactScheduler = async (): Promise<void> => {
  const scheduler = loadReactScheduler();
  const barrier = () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const task = scheduler.unstable_scheduleCallback(
      scheduler.unstable_IdlePriority,
      () => {
        resolve(undefined);
      },
    );
    return { id: taskId(task), ran: promise };
  };
  let previous = barrier();
  for (;;) {
    await previous.ran;
    await nextMacrotask();
    const next = barrier();
    if (next.id === previous.id + 1) {
      await next.ran;
      return;
    }
    previous = next;
  }
};

/**
 * Remove the happy-dom globals only after React has run every scheduled task.
 * Updates that land outside act(), such as a popup opening on its own timer
 * while a test waits for it, leave render work in React's scheduler; that work
 * reads `window` when it runs and must not outlive the DOM.
 */
export const unregisterDomEnvironment = async (): Promise<void> => {
  await drainReactScheduler();
  await GlobalRegistrator.unregister();
};
