// The render-storm check every DOM test runs under (see ./dom-test-preload.ts).
//
// The e2e storm watch's question, asked inside a unit test: does every React
// commit have a cause outside the app? In a DOM test the outside world is the
// test body and its mocks, and React already marks where a test drives it:
// `act()`, which Testing Library wraps around render, rerender, unmount,
// fireEvent, userEvent and waitFor callbacks. So the stimuli are
//
// - each outermost act() scope (+40 tokens), read at commit time from the act
//   queue of the React copy the committing renderer uses: every outermost
//   scope allocates a new queue, nested scopes share it;
// - a mocked network response whose body the app reads (+40);
// - a stream chunk read, and whatever a shared fake calls `stormStimulus()`
//   for (+40);
// - time, on the test's clock: 5 tokens per real second, 60 per second of a
//   fake clock the test advances.
//
// Timers, microtasks, observers, React's scheduler and store notifications
// are not stimuli: a loop runs on them.
//
// Two things fail a test:
//
// 1. Unstimulated: commits drained the bucket (`createStormLedger`). An
//    effect that sets fresh state on every commit drains it whatever its
//    rate, inside act() or outside it.
// 2. Restless: commits outside any act() scope kept landing in
//    `QUIET_TURNS` event-loop turns with no stimulus and no idle stretch in
//    between, during the test or once its body has returned. A quiet tree
//    passes after three idle setImmediate turns, so the check costs
//    microseconds and never waits on the wall clock.
//
// React itself throws only for synchronous nested updates; a passive-effect
// loop inside act() spins in `flushActQueue` forever and never returns to the
// test. So at a violation the guard unmounts the looping root through the
// renderer's own `scheduleRoot` (development builds hand it to the DevTools
// hook), which ends the loop and lets the test fail with the report instead
// of hanging.
//
// A test that loops on purpose wraps the loop in `captureStorm()`, which
// collects the violations instead of failing and fails when none happened.
// There is no other way out of the check.
import { panic, Result } from "better-result";
import { jest } from "bun:test";
import { writeSync } from "node:fs";

import { installCommitHook } from "./commit-hook";
import type { CommitRoot, RendererInternals } from "./commit-hook";
import { createRenderProbe } from "./probe";
import type { ComponentRenders, RenderSnapshot } from "./probe";
import { createStormLedger } from "./storm-ledger";
import type {
  StormLedger,
  StormLedgerLimits,
  StormStimulus,
} from "./storm-ledger";

export type { StormStimulus } from "./storm-ledger";

/** The e2e watch's limits; a DOM test has the same causal budget. */
export const DOM_STORM_LIMITS = {
  bucketCapacity: 120,
  refillPerStimulus: 40,
  tricklePerSecond: 5,
} as const satisfies StormLedgerLimits;

/** A fake second earns twelve real seconds' trickle: 60 tokens. */
const FAKE_CLOCK_WEIGHT = 12;

/**
 * Event-loop turns with commits outside act() a tree may take, with no
 * stimulus and no idle stretch between them, before it counts as restless.
 */
export const QUIET_TURNS = 8;

/**
 * Turns in a row without a commit that make a tree quiet. React's scheduler
 * renders in one turn and flushes the passive effects in the next, so a loop
 * on it commits every other turn: one idle turn proves nothing.
 */
const IDLE_TURNS = 3;

/** The most turns the end of a test waits for its tree to go quiet. */
const SETTLE_TURNS = QUIET_TURNS * IDLE_TURNS;

/** A capture waits longer: a storm outside act() needs turns to show. */
const CAPTURE_TURNS = 4 * SETTLE_TURNS;

/**
 * Commits with no stimulus after which the guard gives up on unmounting the
 * loop and ends the process with the report, before the event-loop watchdog
 * kills it with only a file name.
 */
const HANG_COMMITS = 20_000;

const REPORTED_COMPONENTS = 8;

export type DomStormComponent = ComponentRenders & { name: string };

export type DomStormViolation = {
  kind: "unstimulated" | "restless";
  /** What happened, in one sentence. */
  summary: string;
  /** Components rendered since the last stimulus, most renders first. */
  components: readonly DomStormComponent[];
  /** Whether the guard unmounted the tree to end the loop. */
  unmounted: boolean;
};

export type DomStormReport = {
  /** Commits in the scope. */
  commits: number;
  violations: readonly DomStormViolation[];
};

export type DomStormGuard = {
  /** Starts counting a test's commits (the preload's beforeEach). */
  readonly begin: () => void;
  /**
   * Ends the test: waits a few turns for its tree to stop committing, then
   * throws the report if the test stormed.
   */
  readonly settle: () => Promise<void>;
  /** A driver outside React fed the tree (a mocked stream chunk, a socket message). */
  readonly stimulus: (kind: StormStimulus) => void;
  /** Runs `run`, expecting a storm in it; see `captureStorm`. */
  readonly capture: (run: () => unknown) => Promise<DomStormReport>;
  /** Tests settled so far; the ordering self-test reads it. */
  readonly settled: () => number;
};

type CaptureScope = { violations: DomStormViolation[]; commits: number };

type TestState = {
  ledger: StormLedger;
  walk: (root: CommitRoot) => void;
  reset: () => void;
  snapshot: () => RenderSnapshot;
  commits: number;
  commitsSinceStimulus: number;
  lastStimulus: StormStimulus | "none";
  lastActQueue: unknown;
  /** Commits outside act() since the test started. */
  outsideActCommits: number;
  /** Turns that had commits outside act(), since the last stimulus or idle stretch. */
  busyTurns: number;
  /** Turns in a row without a commit, while the turns are followed. */
  idleTurns: number;
  turnPending: boolean;
  /** The test body returned; the guard is waiting for the tree to go quiet. */
  settling: boolean;
  /** The restless violation reported since the last stimulus, if any. */
  restless: DomStormViolation | undefined;
  /** Unmount the next root that commits: a restless loop was found. */
  unmountPending: boolean;
  unmounted: Set<CommitRoot>;
  violations: DomStormViolation[];
  capture: CaptureScope | undefined;
};

/** The process-wide state of the installed guard. */
type Runtime = {
  current: TestState | undefined;
  settledTests: number;
  turn: number;
  couplingError: string | undefined;
  clock: () => number;
  nextTurn: () => Promise<void>;
  onNextTurn: (callback: () => void) => void;
};

const GUARD = Symbol.for("stll.render-probe.dom-storm-guard");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGuard = (value: unknown): value is DomStormGuard =>
  isRecord(value) &&
  typeof value["begin"] === "function" &&
  typeof value["capture"] === "function";

// --- Report ----------------------------------------------------------------

const topComponents = (
  snapshot: RenderSnapshot,
): readonly DomStormComponent[] =>
  Object.entries(snapshot.components)
    .toSorted(([, left], [, right]) => right.renders - left.renders)
    .slice(0, REPORTED_COMPONENTS)
    .map(([name, entry]) => ({ name, ...entry }));

const formatComponent = ({ name, renders, causes }: DomStormComponent) => {
  const why = Object.entries(causes)
    .filter(([, count]) => count > 0)
    .map(([cause, count]) => `${cause} ${String(count)}`)
    .join(", ");
  return `    ${name}: ${String(renders)} renders (${why})`;
};

const formatViolation = (violation: DomStormViolation) =>
  [
    `  - ${violation.summary}`,
    violation.components.length > 0
      ? "    Rendered since the last stimulus:"
      : "    No component rendered (only host or root updates).",
    ...violation.components.map(formatComponent),
    ...(violation.unmounted
      ? ["    The check unmounted the tree to end the loop."]
      : []),
  ].join("\n");

/** The failure message for a test's violations. */
export const formatDomStormReport = (
  violations: readonly DomStormViolation[],
): string =>
  [
    "Render storm: React kept committing with nothing outside the app driving it.",
    ...violations.map(formatViolation),
    "A render storm is a component that keeps re-rendering itself (an effect, a " +
      "callback ref or a store subscription that sets fresh state on every " +
      "commit). Fix the loop. A test that loops on purpose wraps it in " +
      "captureStorm() from @stll/render-probe/dom-test; a shared fake that " +
      "feeds the tree outside act() (a stream chunk, a socket message) calls " +
      "stormStimulus().",
  ].join("\n");

const unstimulatedSummary = (state: TestState) =>
  `Unstimulated: ${String(state.commitsSinceStimulus)} commits since the last ` +
  `stimulus (${state.lastStimulus === "none" ? "none in this test" : state.lastStimulus}), ` +
  `more than the bucket of ${String(DOM_STORM_LIMITS.bucketCapacity)} and its refills explain.`;

const restlessSummary = (state: TestState) =>
  `Restless: commits outside act() in ${String(state.busyTurns)} event-loop ` +
  `turns with no stimulus and never ${String(IDLE_TURNS)} idle turns in a row, ` +
  `${state.settling ? "after the test body returned" : "during the test"}.`;

const restlessViolation = (state: TestState): DomStormViolation => ({
  kind: "restless",
  summary: restlessSummary(state),
  components: topComponents(state.snapshot()),
  unmounted: false,
});

// --- Per-test state ----------------------------------------------------------

const newLedger = () => createStormLedger(DOM_STORM_LIMITS);

const createTestState = (): TestState => {
  const { probe, onCommit: walk } = createRenderProbe();
  return {
    ledger: newLedger(),
    walk,
    reset: probe.reset,
    snapshot: probe.snapshot,
    commits: 0,
    commitsSinceStimulus: 0,
    lastStimulus: "none",
    lastActQueue: null,
    outsideActCommits: 0,
    busyTurns: 0,
    idleTurns: 0,
    turnPending: false,
    settling: false,
    restless: undefined,
    unmountPending: false,
    unmounted: new Set(),
    violations: [],
    capture: undefined,
  };
};

const stimulate = (runtime: Runtime, state: TestState, kind: StormStimulus) => {
  state.ledger.onStimulus(runtime.clock(), kind);
  state.reset();
  state.commitsSinceStimulus = 0;
  state.lastStimulus = kind;
  state.busyTurns = 0;
  state.idleTurns = 0;
  state.restless = undefined;
  state.unmountPending = false;
};

const record = (state: TestState, violation: DomStormViolation) => {
  (state.capture?.violations ?? state.violations).push(violation);
};

// Ends a loop by unmounting its root through the renderer, once per root.
// React processes the sync update right after the commit that reports it.
const unmount = (
  state: TestState,
  root: CommitRoot,
  renderer: RendererInternals | undefined,
): boolean => {
  const scheduleRoot = renderer?.scheduleRoot;
  if (scheduleRoot === undefined || state.unmounted.has(root)) {
    return false;
  }
  state.unmounted.add(root);
  return Result.try(() => {
    scheduleRoot(root, null);
  }).isOk();
};

const hang = (state: TestState) => {
  const violation: DomStormViolation = {
    kind: "unstimulated",
    summary: `${unstimulatedSummary(state)} Unmounting the tree did not end it; the process exits.`,
    components: topComponents(state.snapshot()),
    unmounted: false,
  };
  writeSync(2, `\n${formatDomStormReport([violation])}\n(in ${Bun.main})\n`);
  process.exit(1);
};

// --- Clock and turns ---------------------------------------------------------

// The ledger's clock: real milliseconds, plus fake milliseconds weighted so
// that a fake second earns sixty tokens. Fake timers freeze
// `performance.now()` except when the test advances them.
const createStormClock = () => {
  let clockAt = performance.now();
  let credited = 0;
  return () => {
    const now = performance.now();
    const elapsed = now - clockAt;
    clockAt = now;
    if (elapsed > 0) {
      credited += jest.isFakeTimers() ? elapsed * FAKE_CLOCK_WEIGHT : elapsed;
    }
    return credited;
  };
};

// Follows the turns after a commit outside act() until the tree has been idle
// for `IDLE_TURNS` turns in a row, counting the turns that committed.
const watchTurns = (runtime: Runtime, state: TestState) => {
  if (state.turnPending) {
    return;
  }
  state.turnPending = true;
  let seen = state.outsideActCommits;
  const onTurn = () => {
    runtime.turn += 1;
    if (runtime.current !== state) {
      state.turnPending = false;
      return;
    }
    if (state.outsideActCommits === seen) {
      state.idleTurns += 1;
      if (state.idleTurns >= IDLE_TURNS) {
        // The tree went quiet.
        state.busyTurns = 0;
        state.idleTurns = 0;
        state.turnPending = false;
        return;
      }
    } else {
      seen = state.outsideActCommits;
      state.idleTurns = 0;
      state.busyTurns += 1;
      if (state.busyTurns >= QUIET_TURNS && state.restless === undefined) {
        state.restless = restlessViolation(state);
        state.unmountPending = true;
        record(state, state.restless);
      }
    }
    runtime.onNextTurn(onTurn);
  };
  runtime.onNextTurn(onTurn);
};

// Turns until the tree has been idle for `IDLE_TURNS` turns in a row, at most
// `maxTurns`; turns are sequential by nature, each observing the previous.
// A quiet tree costs three setImmediate turns.
const waitQuiet = async (
  runtime: Runtime,
  state: TestState,
  maxTurns: number,
): Promise<boolean> => {
  let idle = 0;
  for (let round = 0; round < maxTurns && idle < IDLE_TURNS; round += 1) {
    const before = state.commits;
    await runtime.nextTurn();
    idle = state.commits === before ? idle + 1 : 0;
  }
  return idle >= IDLE_TURNS;
};

// --- Commits -----------------------------------------------------------------

const createCommitListener =
  (runtime: Runtime) =>
  (root: CommitRoot, renderer: RendererInternals | undefined) => {
    const state = runtime.current;
    if (state === undefined) {
      return;
    }
    const queue = renderer?.currentDispatcherRef?.actQueue ?? null;
    if (queue !== null && queue !== state.lastActQueue) {
      state.lastActQueue = queue;
      stimulate(runtime, state, "input");
    }
    state.commits += 1;
    state.commitsSinceStimulus += 1;
    if (state.capture !== undefined) {
      state.capture.commits += 1;
    }
    if (queue === null) {
      state.outsideActCommits += 1;
      watchTurns(runtime, state);
    }
    const found = state.ledger.onCommit(runtime.clock(), runtime.turn);
    // Naming components walks the fiber tree, so it starts only once the
    // bucket is half empty or the tree has kept committing for two turns,
    // which no ordinary test reaches. The walk only names components;
    // counting does not depend on it.
    if (
      state.busyTurns >= 2 ||
      state.ledger.headroom() < DOM_STORM_LIMITS.bucketCapacity / 2
    ) {
      Result.try(() => {
        state.walk(root);
      });
    }
    if (found.length > 0) {
      const components = topComponents(state.snapshot());
      record(state, {
        kind: "unstimulated",
        summary: unstimulatedSummary(state),
        components,
        unmounted: unmount(state, root, renderer),
      });
    } else if (state.unmountPending) {
      state.unmountPending = false;
      const unmounted = unmount(state, root, renderer);
      if (state.restless !== undefined) {
        state.restless.unmounted ||= unmounted;
      }
    }
    if (state.commitsSinceStimulus > HANG_COMMITS) {
      hang(state);
    }
  };

// --- Stimulus taps -----------------------------------------------------------

const BODY_READERS = [
  "json",
  "text",
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
] as const;

// Reading a mocked response body, or a stream chunk, credits the bucket at the
// call, so the commits that follow the read are explained. Crediting at the
// call leaves the promise's timing untouched.
const createStimulusTaps = (onStimulus: (kind: StormStimulus) => void) => {
  const tapped = new WeakSet<object>();
  const stimulated = (original: unknown, kind: StormStimulus) =>
    function readWithStimulus(this: unknown, ...args: unknown[]): unknown {
      onStimulus(kind);
      if (typeof original !== "function") {
        return undefined;
      }
      const result: unknown = Reflect.apply(original, this, args);
      return result;
    };
  const tap = (
    owner: unknown,
    methods: readonly string[],
    kind: StormStimulus,
  ) => {
    const prototype: unknown =
      typeof owner === "function" ? owner.prototype : undefined;
    if (!isRecord(prototype) || tapped.has(prototype)) {
      return;
    }
    tapped.add(prototype);
    for (const method of methods) {
      const original: unknown = Reflect.get(prototype, method);
      if (typeof original === "function") {
        Reflect.set(prototype, method, stimulated(original, kind));
      }
    }
  };
  // A DOM test file installs its window (and its `Response`) after the
  // preload ran, so the taps follow the globals of the running file.
  return () => {
    tap(Reflect.get(globalThis, "Response"), BODY_READERS, "network");
    tap(
      Reflect.get(globalThis, "ReadableStreamDefaultReader"),
      ["read"],
      "stream",
    );
  };
};

// --- The guard ---------------------------------------------------------------

const settleTest = async (runtime: Runtime) => {
  const state = runtime.current;
  if (state === undefined) {
    return;
  }
  state.settling = true;
  const quiet =
    state.commits === 0 || (await waitQuiet(runtime, state, SETTLE_TURNS));
  runtime.current = undefined;
  runtime.settledTests += 1;
  if (runtime.couplingError !== undefined) {
    panic(runtime.couplingError);
  }
  if (!quiet && state.restless === undefined) {
    // Committing every few turns, though not always outside act().
    state.busyTurns = Math.max(state.busyTurns, QUIET_TURNS);
    state.violations.push(restlessViolation(state));
  }
  if (state.violations.length > 0) {
    panic(formatDomStormReport(state.violations));
  }
};

const resetAfterCapture = (state: TestState) => {
  state.capture = undefined;
  // The rest of the test starts from a full bucket.
  state.ledger = newLedger();
  state.reset();
  state.commitsSinceStimulus = 0;
  state.busyTurns = 0;
  state.idleTurns = 0;
  state.restless = undefined;
  state.unmountPending = false;
};

const captureInTest = async (
  runtime: Runtime,
  run: () => unknown,
): Promise<DomStormReport> => {
  const state =
    runtime.current ??
    panic("captureStorm() runs inside a test, not around one.");
  if (state.capture !== undefined) {
    panic("captureStorm() scopes do not nest.");
  }
  const scope: CaptureScope = { violations: [], commits: 0 };
  state.capture = scope;
  const ran = await Result.tryPromise(async () => {
    await run();
    await waitQuiet(runtime, state, CAPTURE_TURNS);
  });
  resetAfterCapture(state);
  if (ran.isErr()) {
    panic("captureStorm(): the captured scope threw", ran.error.cause);
  }
  if (scope.violations.length === 0) {
    state.violations.push({
      kind: "unstimulated",
      summary: `captureStorm() expected a render storm, but its ${String(scope.commits)} commits all had a cause. Remove the capture, or make the scope loop.`,
      components: [],
      unmounted: false,
    });
  }
  return { commits: scope.commits, violations: scope.violations };
};

/**
 * Installs the guard: the commit hook (before any renderer loads), the
 * stimulus taps and the per-test state. Idempotent per process global.
 */
export const installDomTestStormGuard = (): DomStormGuard => {
  const existing: unknown = Reflect.get(globalThis, GUARD);
  if (isGuard(existing)) {
    return existing;
  }
  // Real scheduling, taken before a test can install fake timers (which
  // leave setImmediate alone): a turn is one setImmediate.
  const realSetImmediate = globalThis.setImmediate.bind(globalThis);
  const runtime: Runtime = {
    current: undefined,
    settledTests: 0,
    turn: 0,
    couplingError: undefined,
    clock: createStormClock(),
    nextTurn: async () => {
      await new Promise<void>((resolve) => {
        realSetImmediate(resolve);
      });
    },
    onNextTurn: (callback) => {
      realSetImmediate(callback);
    },
  };

  const hook = installCommitHook(globalThis);
  hook.onRenderer((renderer) => {
    const shared = renderer.currentDispatcherRef;
    // The act queue is React's internal; a React that renamed it would turn
    // every act() commit into an unexplained one.
    if (shared === undefined || !("actQueue" in shared)) {
      runtime.couplingError =
        "React's shared internals no longer expose `actQueue`; the DOM-test storm check cannot see act() scopes. Update packages/render-probe/src/dom-test-guard.ts for this React version.";
    }
  });
  hook.listen(createCommitListener(runtime));

  const stimulus = (kind: StormStimulus) => {
    if (runtime.current !== undefined) {
      stimulate(runtime, runtime.current, kind);
    }
  };
  const tapGlobals = createStimulusTaps(stimulus);
  tapGlobals();

  const guard: DomStormGuard = {
    begin: () => {
      tapGlobals();
      runtime.current = createTestState();
    },
    settle: async () => {
      await settleTest(runtime);
    },
    stimulus,
    capture: async (run) => await captureInTest(runtime, run),
    settled: () => runtime.settledTests,
  };
  Reflect.set(globalThis, GUARD, guard);
  return guard;
};

const installedGuard = (): DomStormGuard | undefined => {
  const guard: unknown = Reflect.get(globalThis, GUARD);
  return isGuard(guard) ? guard : undefined;
};

/**
 * Runs `run` expecting React to storm in it, and returns what the check saw.
 * Violations inside the scope do not fail the test; a scope with none does.
 * Only for tests whose subject is a loop (the storm check's own tests, a
 * canary that must catch one).
 */
export const captureStorm = async (
  run: () => unknown,
): Promise<DomStormReport> => {
  const guard =
    installedGuard() ??
    panic(
      "captureStorm() needs the DOM-test storm check: list packages/render-probe/src/dom-test-preload.ts in this workspace's bunfig.toml.",
    );
  return await guard.capture(run);
};

/**
 * Tells the storm check that something outside React fed the tree: a shared
 * fake delivering a stream chunk or a socket message outside act().
 */
export const stormStimulus = (kind: StormStimulus): void => {
  installedGuard()?.stimulus(kind);
};
