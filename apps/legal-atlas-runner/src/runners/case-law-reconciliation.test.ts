/**
 * The loop's pacing and fairness, neither of which fails loudly.
 *
 * A rotation that is not really a rotation lets one busy source hold the
 * publisher budget while another waits behind it, and looks identical to a
 * healthy loop. An idle backoff that never engages polls the database at the
 * fetch rate forever over a corpus with nothing left to do, and also looks
 * healthy. Both are pinned here.
 *
 * Pacing waits are sliced to stay interruptible, so assertions read the
 * summed gap between turns, never individual sleeps.
 */

import { describe, expect, test } from "bun:test";

import {
  RECONCILIATION_CHECK_SLICE_MS,
  RECONCILIATION_TURN,
  type ReconciliationCounts,
  type ReconciliationLoopTiming,
  type ReconciliationSweepSummary,
  type ReconciliationTurnResult,
  runCaseLawReconciliationLoop,
} from "./case-law-reconciliation";

const TIMING = {
  unitDelayMs: 500,
  idleSleepMs: 1000,
  idleSleepMaxMs: 8000,
  summaryIntervalMs: 10_000,
  failureBackoffMaxMs: 4000,
} as const satisfies ReconciliationLoopTiming;

const counts = (
  overrides: Partial<ReconciliationCounts> = {},
): ReconciliationCounts => ({
  listed: 0,
  keyable: 0,
  unidentifiable: 0,
  heldBefore: 0,
  scheduled: 0,
  written: 0,
  parked: 0,
  terminal: 0,
  resolved: 0,
  failed: 0,
  deferred: 0,
  pruned: 0,
  ...overrides,
});

const WORKED: ReconciliationTurnResult = {
  turn: RECONCILIATION_TURN.WORKED,
  counts: counts({ listed: 100, keyable: 98, heldBefore: 97, written: 1 }),
};
const IDLE: ReconciliationTurnResult = { turn: RECONCILIATION_TURN.IDLE };
const LEASED: ReconciliationTurnResult = { turn: RECONCILIATION_TURN.LEASED };

type LoopEvent =
  | { type: "turn"; adapterKey: string }
  | { type: "sleep"; ms: number };

type LoopRun = {
  events: LoopEvent[];
  summaries: ReconciliationSweepSummary[];
  clock: number;
};

type RunLoopOptions = {
  /** One responder per source, keyed by adapter key, in rotation order. */
  responders: readonly [string, () => ReconciliationTurnResult][];
  /** Turns to allow before the loop is asked to drain. */
  turns: number;
  /** Additionally drain once the fake clock reaches this, mid-wait. */
  drainAtClock?: number;
  timing?: ReconciliationLoopTiming;
};

const runLoop = async ({
  drainAtClock,
  responders,
  timing = TIMING,
  turns,
}: RunLoopOptions): Promise<LoopRun> => {
  const events: LoopEvent[] = [];
  const summaries: ReconciliationSweepSummary[] = [];
  let clock = 0;
  let taken = 0;
  let draining = false;

  await runCaseLawReconciliationLoop({
    sources: responders.map(([adapterKey, respond]) => ({
      adapterKey,
      runWorkUnit: async () => {
        events.push({ type: "turn", adapterKey });
        taken += 1;
        draining ||= taken >= turns;
        return await Promise.resolve(respond());
      },
    })),
    isDraining: () => draining,
    now: () => clock,
    report: (summary) => {
      summaries.push({ ...summary });
    },
    sleep: async (ms) => {
      events.push({ type: "sleep", ms });
      clock += ms;
      draining ||= drainAtClock !== undefined && clock >= drainAtClock;
      await Promise.resolve();
    },
    timing,
  });

  return { events, summaries, clock };
};

/** Summed sleeps recorded between consecutive turns. */
const gapsBetweenTurns = ({ events }: LoopRun): number[] => {
  const gaps: number[] = [];
  let sinceTurn: number | undefined;
  for (const event of events) {
    if (event.type === "turn") {
      if (sinceTurn !== undefined) {
        gaps.push(sinceTurn);
      }
      sinceTurn = 0;
      continue;
    }
    if (sinceTurn !== undefined) {
      sinceTurn += event.ms;
    }
  }
  return gaps;
};

const turnOrder = ({ events }: LoopRun): string[] =>
  events.flatMap((event) => (event.type === "turn" ? [event.adapterKey] : []));

describe("case law reconciliation loop", () => {
  test("every source gets a turn before any source gets a second", async () => {
    // Without this a source with an unbounded backlog crowds out one with a
    // single missing decision, and the second source never recovers it.
    const run = await runLoop({
      responders: [
        ["cz-regional", () => WORKED],
        ["cz-ns", () => WORKED],
        ["pl-courts", () => WORKED],
      ],
      turns: 6,
    });

    expect(turnOrder(run)).toEqual([
      "cz-regional",
      "cz-ns",
      "pl-courts",
      "cz-regional",
      "cz-ns",
      "pl-courts",
    ]);
  });

  test("every turn is paced, whatever it produced", async () => {
    // A leased source cost a database round trip and an idle one cost the
    // whole selection read; neither earns a faster next turn.
    const run = await runLoop({
      responders: [
        ["cz-regional", () => WORKED],
        ["cz-ns", () => LEASED],
      ],
      turns: 2,
    });

    expect(gapsBetweenTurns(run)).toEqual([TIMING.unitDelayMs]);
  });

  test("a rotation with nothing to do backs off, and any work resets it", async () => {
    // The backoff is per rotation, not per turn: with a per-turn test a
    // single busy source would keep every other source polling at the unit
    // rate, which is the cost this exists to avoid.
    const script: ReconciliationTurnResult[] = [IDLE, IDLE, IDLE, IDLE, WORKED];
    let index = 0;
    const respond = (): ReconciliationTurnResult =>
      script[index++] ?? { turn: RECONCILIATION_TURN.IDLE };

    const run = await runLoop({
      responders: [
        ["cz-regional", respond],
        ["cz-ns", respond],
      ],
      turns: 6,
    });

    // Two idle rotations double the wait; the rotation containing work goes
    // back to the unit gap.
    expect(gapsBetweenTurns(run)).toEqual([
      TIMING.unitDelayMs,
      1000,
      TIMING.unitDelayMs,
      2000,
      TIMING.unitDelayMs,
    ]);
  });

  test("a throwing turn neither wedges the loop nor speeds it up", async () => {
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw new Error("transient");
          },
        ],
        ["cz-ns", () => WORKED],
      ],
      turns: 4,
    });

    expect(turnOrder(run)).toEqual([
      "cz-regional",
      "cz-ns",
      "cz-regional",
      "cz-ns",
    ]);
    // The throw is paid by the source that threw, in turns it does not get.
    // The next source asked a publisher nothing yet and owes nothing extra.
    expect(gapsBetweenTurns(run).at(0)).toBe(TIMING.unitDelayMs);
  });

  test("a run of failures backs off to the ceiling and no further", async () => {
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw new Error("unreachable");
          },
        ],
      ],
      turns: 12,
    });

    const gaps = gapsBetweenTurns(run);
    const decreasing = gaps.filter((ms, i) => i > 0 && ms < (gaps[i - 1] ?? 0));

    expect(decreasing).toEqual([]);
    expect(gaps.at(0)).toBe(TIMING.unitDelayMs * 2);
    expect(gaps.at(-1)).toBe(TIMING.failureBackoffMaxMs);
  });

  test("a failing source backs off even while another source keeps succeeding", async () => {
    // With one shared streak counter the healthy source resets it every
    // rotation, so the broken one never gets past its first doubled delay and
    // keeps hitting a failing publisher at nearly full cadence.
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw new Error("publisher down");
          },
        ],
        ["cz-ns", () => WORKED],
      ],
      turns: 8,
    });

    // The streak is served in turns skipped, so the failing source is asked
    // progressively less often while the healthy one keeps its cadence.
    const failingTurns = turnOrder(run).filter((key) => key === "cz-regional");
    expect(failingTurns.length).toBeLessThan(4);
  });

  test("a failing source costs its own turns, never the healthy sources' cadence", async () => {
    // The whole point of a per-source streak: spent as a shared sleep it is
    // not isolation at all, because the loop is sequential. One refusing
    // publisher would then throttle reconciliation for every other source,
    // which is how a single broken source starves the entire corpus.
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw new Error("publisher down");
          },
        ],
        ["cz-ns", () => WORKED],
        ["pl-courts", () => WORKED],
      ],
      turns: 12,
    });

    const healthyGaps = gapsBetweenTurns(run).filter((_, index) => {
      const to = turnOrder(run)[index + 1];
      return to === "cz-ns" || to === "pl-courts";
    });

    // Every healthy turn is reached at the plain unit gap. Under a shared
    // backoff these grow to the failure ceiling and never come back down.
    expect(healthyGaps.every((ms) => ms === TIMING.unitDelayMs)).toBe(true);
  });

  test("every source failing waits out the earliest retry rather than spinning", async () => {
    // A skipped turn costs no pacing gap, so a rotation in which every source
    // is held would otherwise spin at full speed. The wait is to the first
    // expiry, not the idle ceiling: the corpus is unreachable, not settled.
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw new Error("database down");
          },
        ],
        [
          "cz-ns",
          () => {
            throw new Error("database down");
          },
        ],
      ],
      turns: 6,
    });

    const zeroGaps = gapsBetweenTurns(run).filter((ms) => ms === 0);

    expect(zeroGaps).toEqual([]);
    expect(run.clock).toBeLessThanOrEqual(TIMING.failureBackoffMaxMs * 6);
  });

  test("a recovered source starts its next streak from scratch", async () => {
    let turn = 0;
    const respond = (): ReconciliationTurnResult => {
      turn += 1;
      // Fails, fails, succeeds, then fails again: the streak must restart.
      if (turn === 3) {
        return WORKED;
      }
      throw new Error("intermittent");
    };

    const run = await runLoop({
      responders: [["cz-regional", respond]],
      turns: 4,
    });

    const gaps = gapsBetweenTurns(run);
    expect(gaps.at(0)).toBe(TIMING.unitDelayMs * 2);
    expect(gaps.at(1)).toBe(TIMING.unitDelayMs * 4);
    // The successful turn pays the plain gap...
    expect(gaps.at(2)).toBe(TIMING.unitDelayMs);
  });

  test("every pacing wait stays interruptible: no sleep exceeds one slice", async () => {
    // The idle ceiling is minutes in production; a SIGTERM must interrupt it
    // within a slice instead of waiting it out.
    const run = await runLoop({
      responders: [["cz-regional", () => IDLE]],
      turns: 6,
    });

    expect(
      run.events.filter(
        (event) =>
          event.type === "sleep" && event.ms > RECONCILIATION_CHECK_SLICE_MS,
      ),
    ).toEqual([]);
  });

  test("a drain request interrupts an idle wait mid-gap", async () => {
    const run = await runLoop({
      responders: [["cz-regional", () => IDLE]],
      turns: Number.POSITIVE_INFINITY,
      timing: { ...TIMING, idleSleepMs: 3500 },
      drainAtClock: 1500,
    });

    // The 3500ms idle gap ended after two slices, not four.
    expect(run.clock).toBe(2000);
    expect(turnOrder(run)).toEqual(["cz-regional"]);
  });

  test("the summary sums the window's counters and flushes on the way out", async () => {
    const run = await runLoop({
      responders: [
        ["cz-regional", () => WORKED],
        ["cz-ns", () => LEASED],
      ],
      turns: 4,
    });

    // A process replaced mid-window must not take its tallies with it.
    expect(run.summaries).toHaveLength(1);
    expect(run.summaries.at(0)).toMatchObject({
      worked: 2,
      leased: 2,
      idle: 0,
      errored: 0,
      listed: 200,
      keyable: 196,
      heldBefore: 194,
      written: 2,
    });
  });

  test("an idle window reports nothing at all", async () => {
    // Progress and error rate are the signal; a stream of zero-row summaries
    // would bury both. Liveness is the daemon's heartbeat.
    const run = await runLoop({
      responders: [["cz-regional", () => IDLE]],
      turns: 30,
    });

    expect(run.summaries).toEqual([]);
  });

  test("a failure is reported with the error that caused it", async () => {
    const failure = new Error("transient");
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw failure;
          },
        ],
      ],
      turns: 1,
    });

    expect(run.summaries.at(0)).toMatchObject({
      errored: 1,
      lastError: failure,
      erroredSources: ["cz-regional"],
    });
  });

  test("a window names every source that threw, each once", async () => {
    // An error count alone cannot separate one broken publisher from a
    // dependency they all share, and the two want opposite responses. A
    // source that threw repeatedly must not crowd the others out of the list.
    const run = await runLoop({
      responders: [
        [
          "cz-regional",
          () => {
            throw new Error("publisher down");
          },
        ],
        ["cz-ns", () => WORKED],
        [
          "pl-courts",
          () => {
            throw new Error("publisher down");
          },
        ],
      ],
      turns: 12,
    });

    expect(run.summaries.at(0)?.erroredSources).toEqual([
      "cz-regional",
      "pl-courts",
    ]);
  });

  test("a deployment with no reconcilable source returns instead of spinning", async () => {
    const run = await runLoop({ responders: [], turns: 1 });
    expect(run.events).toEqual([]);
  });
});
