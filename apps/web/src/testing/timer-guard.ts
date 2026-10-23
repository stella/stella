import { panic } from "better-result";

/**
 * No timer a test starts may outlive it. A first-party timeout or interval
 * still pending when its test ends fires later inside some other test, where
 * it reports through process-wide singletons (analytics, toasts) that test is
 * asserting on: an unattributed flake far from its cause. The guard records
 * every timer first-party code starts during a test and, when the test ends,
 * clears whatever is still pending and fails that test with each timer's
 * creation stack.
 *
 * Timers started inside dependencies are left to them: a library owns its
 * own scheduling (query caches, toasts), and its timers are not ours to
 * cancel. DOM tests schedule through happy-dom's timers, which the DOM's own
 * teardown cancels (see `installDomNetworkGuard`).
 *
 * The test preload installs the guard and owns the lifecycle hooks.
 */
type PendingTimer = {
  kind: "timeout" | "interval";
  stack: string;
  clear: () => void;
};

const pending = new Map<unknown, PendingTimer>();
const leakedTimers: string[] = [];
let testRunning = false;

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;

const DEPENDENCY_FRAME = /[/\\]node_modules[/\\]/u;
const RUNTIME_FRAME = /\((?:native|internal:)|at (?:native|internal:)/u;
const GUARD_FRAME = /[/\\]testing[/\\]timer-guard\.ts/u;

// The stack of the code that started the timer, or null when a dependency or
// the runtime started it (its first caller frame is not first-party source).
const firstPartyStack = (): string | null => {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, firstPartyStack);
  const frames = (holder.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((frame) => !GUARD_FRAME.test(frame));
  const caller = frames.find((frame) => !RUNTIME_FRAME.test(frame));
  if (caller === undefined || DEPENDENCY_FRAME.test(caller)) {
    return null;
  }
  return frames.join("\n");
};

const track = (
  handle: unknown,
  kind: PendingTimer["kind"],
  clear: () => void,
): PendingTimer | null => {
  if (!testRunning) {
    return null;
  }
  const stack = firstPartyStack();
  if (stack === null) {
    return null;
  }
  const timer = { kind, stack, clear };
  pending.set(handle, timer);
  return timer;
};

const forget = (handle: unknown) => {
  if (pending.delete(handle)) {
    return;
  }
  // Callers may clear by the numeric id the handle converts to.
  for (const key of pending.keys()) {
    if (Number(key) === Number(handle)) {
      pending.delete(key);
      return;
    }
  }
};

const guardedSetTimeout = ((
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
) => {
  // A timeout stays tracked until it is cleared or its callback returns
  // without re-arming it: refresh() re-arms the native timer directly, so the
  // handle's refresh registers it again.
  let firing = false;
  let rearmed = false;
  const handle = realSetTimeout(
    (...callbackArgs: unknown[]) => {
      firing = true;
      rearmed = false;
      try {
        return callback(...callbackArgs);
      } finally {
        firing = false;
        if (!rearmed) {
          forget(handle);
        }
      }
    },
    delay,
    ...args,
  );
  const timer = track(handle, "timeout", () => {
    realClearTimeout(handle);
  });
  const refresh = handle.refresh.bind(handle);
  Object.defineProperty(handle, "refresh", {
    value: () => {
      refresh();
      if (firing) {
        rearmed = true;
      } else if (timer !== null && testRunning) {
        pending.set(handle, timer);
      }
      return handle;
    },
  });
  return handle;
}) as typeof setTimeout;

const guardedSetInterval = ((
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
) => {
  const handle = realSetInterval(callback, delay, ...args);
  track(handle, "interval", () => {
    realClearInterval(handle);
  });
  return handle;
}) as typeof setInterval;

const guardedClearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
  forget(handle);
  realClearTimeout(handle);
}) as typeof clearTimeout;

const guardedClearInterval = ((
  handle?: Parameters<typeof clearInterval>[0],
) => {
  forget(handle);
  realClearInterval(handle);
}) as typeof clearInterval;

/** Records first-party timers from now on against the running test. */
export const markTimerTestStarted = () => {
  testRunning = true;
};

/**
 * Ends the running test: clears every first-party timer it left pending and
 * records each one, so they can neither fire into later tests nor pass.
 */
export const markTimerTestEnded = () => {
  testRunning = false;
  for (const timer of pending.values()) {
    timer.clear();
    leakedTimers.push(
      `${timer.kind} still pending, started at:\n${timer.stack}`,
    );
  }
  pending.clear();
};

/**
 * Hands over the leaks recorded so far and forgets them. Only the guard's own
 * regression test takes them: it leaks timers on purpose and asserts on them.
 */
export const takeLeakedTimers = (): readonly string[] => leakedTimers.splice(0);

/** Fails with every leaked timer recorded since the last report, if any. */
export const reportLeakedTimers = () => {
  const leaks = takeLeakedTimers();
  if (leaks.length === 0) {
    return;
  }
  panic(
    `Timer(s) outlived their test: settle, cancel or await them before the test ends (a test that reads a bounded response must consume or cancel its body).\n${leaks.map((leak) => `  - ${leak}`).join("\n")}`,
  );
};

/** Routes the global timer functions through the guard. */
export const installTimerGuard = () => {
  Object.assign(globalThis, {
    setTimeout: guardedSetTimeout,
    setInterval: guardedSetInterval,
    clearTimeout: guardedClearTimeout,
    clearInterval: guardedClearInterval,
  });
};
