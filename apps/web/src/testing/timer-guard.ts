import { panic } from "better-result";

/**
 * No timer a test starts may outlive it. A first-party timeout or interval
 * still pending when its test ends fires later inside some other test, where
 * it reports through process-wide singletons (analytics, toasts) that test is
 * asserting on: an unattributed flake far from its cause. The guard records
 * every timer first-party code starts during a test and, when the test ends,
 * cancels whichever is still live and fails that test with each timer's
 * creation stack.
 *
 * Liveness is the runtime's own record (`_destroyed`), never a mirror of the
 * calls that end a timer: a timer can fire, be cleared, closed, disposed or
 * refreshed from its callback, and only the runtime sees every path.
 *
 * Timers started inside dependencies are left to them: a library owns its
 * own scheduling (query caches, toasts), and its timers are not ours to
 * cancel. DOM tests schedule through happy-dom's timers, which the DOM's own
 * teardown cancels (see `installDomNetworkGuard`).
 *
 * The test preload installs the guard and owns the lifecycle hooks.
 */
type RuntimeTimer = ReturnType<typeof setTimeout>;
type StartedTimer = {
  kind: "timeout" | "interval";
  stack: string;
  handle: RuntimeTimer;
};

const started: StartedTimer[] = [];
const leakedTimers: string[] = [];
let testRunning = false;

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

const DEPENDENCY_FRAME = /[/\\]node_modules[/\\]/u;
const RUNTIME_FRAME = /\((?:native|internal:)|at (?:native|internal:)/u;
const GUARD_FRAME = /[/\\]testing[/\\]timer-guard\.ts/u;

/** Whether the runtime still has this timer scheduled. */
export const isLiveTimer = (handle: RuntimeTimer): boolean => {
  const destroyed: unknown = Reflect.get(handle, "_destroyed");
  if (typeof destroyed !== "boolean") {
    return panic(
      "The runtime's timers no longer expose `_destroyed`; the timer guard cannot tell a live timer from a finished one.",
    );
  }
  return !destroyed;
};

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

const record = (handle: RuntimeTimer, kind: StartedTimer["kind"]) => {
  if (!testRunning) {
    return;
  }
  const stack = firstPartyStack();
  if (stack !== null) {
    started.push({ kind, stack, handle });
  }
};

const guardedSetTimeout = (...args: Parameters<typeof setTimeout>) => {
  const handle = realSetTimeout(...args);
  record(handle, "timeout");
  return handle;
};

const guardedSetInterval = (...args: Parameters<typeof setInterval>) => {
  const handle = realSetInterval(...args);
  record(handle, "interval");
  return handle;
};

/** Records first-party timers from now on against the running test. */
export const markTimerTestStarted = () => {
  testRunning = true;
};

/**
 * Ends the running test: cancels every first-party timer it started that is
 * still live and records each one, so none can fire into later tests or pass.
 */
export const markTimerTestEnded = () => {
  testRunning = false;
  for (const timer of started.splice(0)) {
    if (!isLiveTimer(timer.handle)) {
      continue;
    }
    timer.handle.close();
    leakedTimers.push(
      `${timer.kind} still pending, started at:\n${timer.stack}`,
    );
  }
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

/** Routes the global timer constructors through the guard. */
export const installTimerGuard = () => {
  Object.assign(globalThis, {
    setTimeout: guardedSetTimeout,
    setInterval: guardedSetInterval,
  });
};
