// Decides whether React commits have a cause outside the app.
//
// A render storm is not a high commit rate: six menus opened by a test in
// two seconds commit fast for a reason, while a layout effect that sets state
// on every commit keeps going at sixty a second with nobody touching the
// page. So the ledger asks a causal question rather than a rate one: did
// something outside the app (an input event, a network response, a stream
// chunk, a socket message) happen recently enough to explain these commits?
//
// The invariant, independent of how fast a test drives the page: commits
// spend tokens from a bucket that outside stimuli refill, plus a slow time
// trickle for timers such as a ticking clock. A loop earns no refills and
// drains the bucket whatever its rate; a test that clicks fast earns a
// refill per click.
//
// The ledger also records the most commits one browser task made, as a
// measurement only: what counts as one task is approximate (a commit-posted
// message can land behind React's own scheduler tasks, more so on a loaded
// runner), so it informs budgets rather than failing tests. An unbounded
// cascade in one task already makes React throw at fifty nested updates.
//
// The third invariant, that an idle page stops committing, needs the test's
// end and lives with the driver (see `quiescence` below).
//
// Pure and clock-injected, so it runs the same in a browser, a DOM test and
// a unit test.

export type StormStimulus =
  "input" | "network" | "stream" | "message" | "navigation";

export type StormLedgerLimits = {
  /** Most unexplained commits the bucket holds. */
  bucketCapacity: number;
  /** Tokens one outside stimulus adds. */
  refillPerStimulus: number;
  /** Tokens the bucket gains per second with no stimulus at all. */
  tricklePerSecond: number;
};

/**
 * Starting limits, to be calibrated on main's runs while the watch only
 * reports. A menu takes about fifteen commits to open and nine to close, the
 * tooltip menu up to twenty-five by keyboard
 * (e2e/ui-playground/menu-commits.geometry.spec.ts); chat streaming commits
 * about twenty a second, each emit driven by a stream read.
 */
export const DEFAULT_STORM_LIMITS = {
  bucketCapacity: 120,
  refillPerStimulus: 40,
  tricklePerSecond: 5,
} as const satisfies StormLedgerLimits;

export type StormViolation = {
  kind: "unstimulated";
  at: number;
  /** Commits since the last outside stimulus. */
  commitsSinceStimulus: number;
  /** Milliseconds since the last outside stimulus. */
  msSinceStimulus: number;
  lastStimulus: StormStimulus | "none";
};

export type StormLedgerReport = {
  commits: number;
  stimuli: Record<StormStimulus, number>;
  violations: StormViolation[];
  /** The most commits a single browser task made, approximately. */
  widestTask: number;
  /**
   * The fewest tokens the bucket held, before any refill a violation made:
   * the headroom a calibration reads.
   */
  lowestTokens: number;
};

export type StormLedger = {
  /** A React commit at `now`, inside the browser task `task`. */
  readonly onCommit: (now: number, task: number) => StormViolation[];
  readonly onStimulus: (now: number, stimulus: StormStimulus) => void;
  /** Tokens left in the bucket, as of the last commit or stimulus. */
  readonly headroom: () => number;
  readonly report: () => StormLedgerReport;
};

const emptyStimuli = (): Record<StormStimulus, number> => ({
  input: 0,
  network: 0,
  stream: 0,
  message: 0,
  navigation: 0,
});

export const createStormLedger = (
  limits: StormLedgerLimits = DEFAULT_STORM_LIMITS,
): StormLedger => {
  let tokens = limits.bucketCapacity;
  let tokensAt: number | undefined;
  let commits = 0;
  let stimuli = emptyStimuli();
  const violations: StormViolation[] = [];
  let widestTask = 0;
  let lowestTokens: number = limits.bucketCapacity;

  let currentTask: number | undefined;
  let commitsInTask = 0;

  let lastStimulus: StormStimulus | "none" = "none";
  let lastStimulusAt: number | undefined;
  let commitsSinceStimulus = 0;

  const trickle = (now: number) => {
    if (tokensAt !== undefined && now > tokensAt) {
      tokens = Math.min(
        limits.bucketCapacity,
        tokens + ((now - tokensAt) / 1000) * limits.tricklePerSecond,
      );
    }
    tokensAt = now;
  };

  const onStimulus = (now: number, stimulus: StormStimulus) => {
    trickle(now);
    tokens = Math.min(limits.bucketCapacity, tokens + limits.refillPerStimulus);
    stimuli = { ...stimuli, [stimulus]: stimuli[stimulus] + 1 };
    lastStimulus = stimulus;
    lastStimulusAt = now;
    commitsSinceStimulus = 0;
  };

  const onCommit = (now: number, task: number): StormViolation[] => {
    const found: StormViolation[] = [];
    commits += 1;
    commitsSinceStimulus += 1;

    if (task === currentTask) {
      commitsInTask += 1;
    } else {
      currentTask = task;
      commitsInTask = 1;
    }
    widestTask = Math.max(widestTask, commitsInTask);

    trickle(now);
    tokens -= 1;
    lowestTokens = Math.min(lowestTokens, tokens);
    if (tokens < 0) {
      found.push({
        kind: "unstimulated",
        at: now,
        commitsSinceStimulus,
        msSinceStimulus:
          lastStimulusAt === undefined ? now : now - lastStimulusAt,
        lastStimulus,
      });
      // One report per drained bucket: refill and keep counting, so a
      // storm that goes on reports again once it has drained it again.
      tokens = limits.bucketCapacity;
    }

    violations.push(...found);
    return found;
  };

  return {
    onCommit,
    onStimulus,
    headroom: () => tokens,
    report: () => ({
      commits,
      stimuli: { ...stimuli },
      violations: [...violations],
      widestTask,
      lowestTokens: Math.floor(lowestTokens),
    }),
  };
};

export type QuiescenceLimits = {
  /** How long the page must go without a commit. */
  quietMs: number;
  /** How long to wait for that quiet stretch before giving up. */
  timeoutMs: number;
};

export const DEFAULT_QUIESCENCE_LIMITS = {
  quietMs: 300,
  timeoutMs: 5000,
} as const satisfies QuiescenceLimits;
