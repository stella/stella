/**
 * The walk's pacing and the one failure it exists to make visible, neither of
 * which fails loudly on its own.
 *
 * An idle backoff that never engages polls a settled corpus at the duty-cycle
 * rate forever and looks healthy. A failure backoff derived from a duty cycle
 * an operator set to zero asks a refusing database again as fast as it can
 * refuse, and also looks healthy. And a walk that examines nothing while the
 * queue has work in it emits exactly the same log as a walk with nothing to
 * do. All three are pinned here.
 *
 * The walk's position is deliberately absent from this file: it is read and
 * written inside the same locked transaction as the batch, so it is not a
 * thing this loop can get wrong.
 *
 * Pacing waits are sliced to stay interruptible, so assertions read the summed
 * gap between turns, never individual sleeps.
 */

import { expect, test } from "bun:test";

import type { CitationResolutionCounts } from "@/api/handlers/case-law/citation-resolution";
import { countsByRule } from "@/api/handlers/case-law/citation-resolution-status";

import {
  CITATION_RESOLUTION_STEP,
  type CitationResolutionDrainSummary,
  type CitationResolutionDrainTiming,
  type CitationResolutionStep,
  runCitationResolutionDrain,
} from "./citation-resolution-drain";

const TIMING = {
  batchDelayMs: 500,
  idleSleepMs: 1000,
  idleSleepMaxMs: 8000,
  summaryIntervalMs: 10_000,
  failureBackoffMinMs: 200,
  failureBackoffMaxMs: 4000,
  idleContradictionWindows: 2,
} as const satisfies CitationResolutionDrainTiming;

const counts = (
  overrides: Partial<CitationResolutionCounts> = {},
): CitationResolutionCounts => ({
  scanned: 0,
  resolved: 0,
  resolvedByRule: countsByRule(() => 0),
  unmatched: 0,
  ambiguous: 0,
  jurisdictionBlocked: 0,
  undeclaredJurisdiction: 0,
  ...overrides,
});

const SETTLED: CitationResolutionStep = {
  type: CITATION_RESOLUTION_STEP.SETTLED,
  counts: counts({ scanned: 10, resolved: 7, unmatched: 3 }),
};

const DRAINED: CitationResolutionStep = {
  type: CITATION_RESOLUTION_STEP.DRAINED,
};
const BUSY: CitationResolutionStep = { type: CITATION_RESOLUTION_STEP.BUSY };

type DrainEvent =
  | { type: "batch"; atMs: number }
  | { type: "sleep"; ms: number };

type DrainRun = {
  events: DrainEvent[];
  summaries: CitationResolutionDrainSummary[];
};

type RunDrainOptions = {
  /** One response per turn, in order; the last repeats once exhausted. */
  steps: readonly (CitationResolutionStep | "throw")[];
  /** Turns to allow before the loop is asked to drain. */
  turns: number;
  /** Pending gauge readings, in window order; the last repeats. */
  pending?: readonly number[];
  timing?: CitationResolutionDrainTiming;
  /** What a `"throw"` step raises. */
  thrown?: () => unknown;
};

const runDrain = async ({
  pending = [0],
  steps,
  timing = TIMING,
  turns,
  thrown = () => new Error("batch failed"),
}: RunDrainOptions): Promise<DrainRun> => {
  const events: DrainEvent[] = [];
  const summaries: CitationResolutionDrainSummary[] = [];
  let clock = 0;
  let taken = 0;
  let windows = 0;
  let draining = false;

  await runCitationResolutionDrain({
    settleBatch: async () => {
      events.push({ type: "batch", atMs: clock });
      const step = steps[Math.min(taken, steps.length - 1)];
      taken += 1;
      draining ||= taken >= turns;
      if (step === "throw" || step === undefined) {
        throw thrown();
      }
      return await Promise.resolve(step);
    },
    readPending: async () => {
      const value = pending[Math.min(windows, pending.length - 1)] ?? 0;
      windows += 1;
      return await Promise.resolve(value);
    },
    errorTag: (error) => (error instanceof Error ? "Error" : "Unknown"),
    isDraining: () => draining,
    now: () => clock,
    report: (summary) => {
      summaries.push({ ...summary });
    },
    sleep: async (ms) => {
      events.push({ type: "sleep", ms });
      clock += ms;
      await Promise.resolve();
    },
    timing,
  });

  return { events, summaries };
};

const batchStarts = (events: readonly DrainEvent[]): number[] =>
  events.flatMap((event) => (event.type === "batch" ? [event.atMs] : []));

/**
 * The gap between two turns, by index. Named rather than subtracted inline
 * with non-null assertions: a missing turn is the failure these tests exist to
 * catch, and `starts.at(n)! - starts.at(n - 1)!` reports it as `NaN` instead
 * of saying which turn never happened.
 */
const gapBefore = (events: readonly DrainEvent[], turn: number): number => {
  const starts = batchStarts(events);
  const from = starts.at(turn - 1);
  const to = starts.at(turn);
  if (from === undefined || to === undefined) {
    throw new Error(
      `expected at least ${turn + 1} turns, saw ${starts.length}`,
    );
  }
  return to - from;
};

test("a settled turn is paced by the duty cycle, not by its result", async () => {
  const { events } = await runDrain({ steps: [SETTLED], turns: 3 });
  expect(gapBefore(events, 1)).toBe(TIMING.batchDelayMs);
});

test("an empty batch backs off towards the idle ceiling", async () => {
  const { events } = await runDrain({
    steps: [SETTLED, DRAINED],
    turns: 4,
  });
  expect(gapBefore(events, 2)).toBe(TIMING.idleSleepMs);
  expect(gapBefore(events, 3)).toBe(TIMING.idleSleepMs * 2);
});

test("a settled turn resets the idle backoff", async () => {
  const { events } = await runDrain({
    steps: [DRAINED, DRAINED, SETTLED, DRAINED],
    turns: 5,
  });
  expect(gapBefore(events, 2)).toBe(TIMING.idleSleepMs * 2);
  // The settled turn pays the duty cycle and puts the idle floor back.
  expect(gapBefore(events, 3)).toBe(TIMING.batchDelayMs);
  expect(gapBefore(events, 4)).toBe(TIMING.idleSleepMs);
});

test("a held walk waits instead of spinning", async () => {
  const { events } = await runDrain({ steps: [BUSY], turns: 3 });
  expect(gapBefore(events, 1)).toBe(TIMING.idleSleepMs);
});

test("a throwing batch backs off and the walk continues", async () => {
  const { events, summaries } = await runDrain({
    steps: ["throw"],
    turns: 4,
  });
  expect(gapBefore(events, 1)).toBe(TIMING.batchDelayMs);
  expect(gapBefore(events, 2)).toBe(TIMING.batchDelayMs * 2);
  expect(summaries.at(-1)).toMatchObject({ errored: 4, lastErrorTag: "Error" });
});

test("a wedged walk reports which database error wedged it", async () => {
  // Every failure raised inside a prepared query arrives as the same wrapper,
  // so the tag alone reads "DrizzleQueryError" whether the statement hit a
  // missing column, a privilege, or a constraint. Without the SQLSTATE beside
  // it a stalled walk is diagnosable only from the database's own logs.
  const { summaries } = await runDrain({
    steps: ["throw"],
    turns: 3,
    thrown: () =>
      new Error("Failed query: select ...", {
        cause: Object.assign(new Error("permission denied"), {
          // Bun's driver puts the SQLSTATE in `errno`; `code` is the generic
          // category, which is why the category alone cannot name the fault.
          errno: "42501",
          code: "ERR_POSTGRES_SERVER_ERROR",
          table: "case_law_citations",
          column: "cited_court_hint",
        }),
      }),
  });
  expect(summaries.at(-1)?.lastErrorPgFields).toEqual({
    "error.cause.pg_code": "42501",
    "error.cause.pg_table": "case_law_citations",
    "error.cause.pg_column": "cited_court_hint",
  });
});

test("a walk stopped by something other than the database reports no pg fields", async () => {
  const { summaries } = await runDrain({ steps: ["throw"], turns: 3 });
  expect(summaries.at(-1)?.lastErrorPgFields).toEqual({});
});

test("the failure backoff has a floor of its own when pacing is zero", async () => {
  // A backfill may legitimately run with no gap between batches. Deriving the
  // backoff from that gap would make every failure delay zero, and a database
  // refusing statements would be asked again as fast as it can refuse.
  const { events } = await runDrain({
    steps: ["throw"],
    turns: 4,
    timing: { ...TIMING, batchDelayMs: 0 },
  });
  expect(gapBefore(events, 1)).toBe(TIMING.failureBackoffMinMs);
  expect(gapBefore(events, 2)).toBe(TIMING.failureBackoffMinMs * 2);
});

test("work waiting with nothing examined is reported as a contradiction", async () => {
  // The failure a log of successes cannot carry: a wedged walk and an empty
  // queue produce the same silence otherwise. Two windows, because one can
  // straddle a deployment or a lock handoff.
  const { summaries } = await runDrain({
    steps: [BUSY],
    pending: [4_000_000],
    turns: 40,
    timing: { ...TIMING, summaryIntervalMs: 1000 },
  });
  const contradicting = summaries.flatMap((summary) =>
    summary.idleContradictionWindows === null
      ? []
      : [summary.idleContradictionWindows],
  );
  expect(summaries.at(0)?.idleContradictionWindows).toBeNull();
  expect(contradicting.at(0)).toBe(TIMING.idleContradictionWindows);
  expect(summaries.at(-1)?.pending).toBe(4_000_000);
});

test("an empty queue with no work examined is not a contradiction", async () => {
  const { summaries } = await runDrain({
    steps: [DRAINED],
    pending: [0],
    turns: 40,
    timing: { ...TIMING, summaryIntervalMs: 1000 },
  });
  expect(
    summaries.every((summary) => summary.idleContradictionWindows === null),
  ).toBe(true);
});

test("a window that examined rows is never a contradiction", async () => {
  // `scanned`, not `resolved`, is the progress test: a batch that examined
  // rows and matched none of them still emptied that much of the queue.
  const { summaries } = await runDrain({
    steps: [
      {
        type: CITATION_RESOLUTION_STEP.SETTLED,
        counts: counts({ scanned: 10, unmatched: 10 }),
      },
    ],
    pending: [4_000_000],
    turns: 40,
    timing: { ...TIMING, summaryIntervalMs: 1000 },
  });
  expect(
    summaries.every((summary) => summary.idleContradictionWindows === null),
  ).toBe(true);
});

test("the window in hand is reported when the process drains", async () => {
  const { summaries } = await runDrain({ steps: [SETTLED], turns: 2 });
  // Without the flush at the end, a process replaced mid-window reports its
  // tallies nowhere at all.
  expect(summaries).toHaveLength(1);
  expect(summaries.at(0)).toMatchObject({
    batches: 2,
    scanned: 20,
    resolved: 14,
    unmatched: 6,
  });
});
