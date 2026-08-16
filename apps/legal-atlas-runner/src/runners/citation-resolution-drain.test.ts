/**
 * The walk's pacing, its cursor wrap, and the one failure it exists to make
 * visible — none of which fails loudly on its own.
 *
 * A walk that never wraps its cursor stops seeing the rows an arriving
 * decision reopened behind it, and looks identical to a healthy one because
 * the batches it does run all succeed. An idle backoff that never engages
 * polls a settled corpus at the duty-cycle rate forever, and also looks
 * healthy. And a walk that examines nothing while the queue has work in it
 * emits exactly the same log as a walk with nothing to do. All three are
 * pinned here.
 *
 * Pacing waits are sliced to stay interruptible, so assertions read the summed
 * gap between turns, never individual sleeps.
 */

import { expect, test } from "bun:test";

import type {
  CitationResolutionCounts,
  CitationResolutionCursor,
} from "@/api/handlers/case-law/citation-resolution";

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
  failureBackoffMaxMs: 4000,
  idleContradictionWindows: 2,
} as const satisfies CitationResolutionDrainTiming;

const counts = (
  overrides: Partial<CitationResolutionCounts> = {},
): CitationResolutionCounts => ({
  scanned: 0,
  resolved: 0,
  unmatched: 0,
  ambiguous: 0,
  jurisdictionBlocked: 0,
  undeclaredJurisdiction: 0,
  ...overrides,
});

const cursorAt = (n: number): CitationResolutionCursor => ({
  citingDecisionId: `decision-${n}`,
  citationId: `citation-${n}`,
});

const settled = (n: number): CitationResolutionStep => ({
  type: CITATION_RESOLUTION_STEP.SETTLED,
  counts: counts({ scanned: 10, resolved: 7, unmatched: 3 }),
  cursor: cursorAt(n),
});

const DRAINED: CitationResolutionStep = {
  type: CITATION_RESOLUTION_STEP.DRAINED,
};
const BUSY: CitationResolutionStep = { type: CITATION_RESOLUTION_STEP.BUSY };

type DrainEvent =
  | { type: "batch"; after: CitationResolutionCursor | null; atMs: number }
  | { type: "sleep"; ms: number };

type DrainRun = {
  events: DrainEvent[];
  saved: (CitationResolutionCursor | null)[];
  summaries: CitationResolutionDrainSummary[];
};

type RunDrainOptions = {
  /** One response per turn, in order; the last repeats once exhausted. */
  steps: readonly (CitationResolutionStep | "throw")[];
  /** Turns to allow before the loop is asked to drain. */
  turns: number;
  /** Pending gauge readings, in window order; the last repeats. */
  pending?: readonly number[];
  startCursor?: CitationResolutionCursor | null;
  timing?: CitationResolutionDrainTiming;
};

const runDrain = async ({
  pending = [0],
  startCursor = null,
  steps,
  timing = TIMING,
  turns,
}: RunDrainOptions): Promise<DrainRun> => {
  const events: DrainEvent[] = [];
  const saved: (CitationResolutionCursor | null)[] = [];
  const summaries: CitationResolutionDrainSummary[] = [];
  let clock = 0;
  let taken = 0;
  let windows = 0;
  let draining = false;

  await runCitationResolutionDrain({
    settleBatch: async (after) => {
      events.push({ type: "batch", after, atMs: clock });
      const step = steps[Math.min(taken, steps.length - 1)];
      taken += 1;
      draining ||= taken >= turns;
      if (step === "throw" || step === undefined) {
        throw new Error("batch failed");
      }
      return await Promise.resolve(step);
    },
    loadCursor: async () => await Promise.resolve(startCursor),
    saveCursor: async (cursor) => {
      saved.push(cursor);
      await Promise.resolve();
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

  return { events, saved, summaries };
};

const batchStarts = (events: readonly DrainEvent[]): number[] =>
  events.flatMap((event) => (event.type === "batch" ? [event.atMs] : []));

const cursorsAsked = (
  events: readonly DrainEvent[],
): (CitationResolutionCursor | null)[] =>
  events.flatMap((event) => (event.type === "batch" ? [event.after] : []));

test("the walk resumes from the persisted position", async () => {
  const { events } = await runDrain({
    steps: [settled(2)],
    startCursor: cursorAt(1),
    turns: 1,
  });
  expect(cursorsAsked(events).at(0)).toEqual(cursorAt(1));
});

test("a settled turn is paced by the duty cycle, not by its result", async () => {
  const { events } = await runDrain({ steps: [settled(1)], turns: 3 });
  const starts = batchStarts(events);
  // Throughput is this gap and nothing else: the database serving the walk is
  // also serving readers, so a turn that found plenty does not earn a faster
  // next one.
  expect(starts.at(1)! - starts.at(0)!).toBe(TIMING.batchDelayMs);
});

test("an empty batch wraps the cursor and backs off", async () => {
  const { events, saved } = await runDrain({
    steps: [settled(1), DRAINED],
    turns: 4,
  });
  // Wrapping is not an optimisation: a decision arriving mid-walk reopens
  // citations behind the cursor, and nothing else would ever reach them.
  expect(saved).toEqual([cursorAt(1), null, null, null]);
  expect(cursorsAsked(events).at(2)).toBeNull();
  const starts = batchStarts(events);
  // Doubling from the idle floor, so a settled corpus stops asking.
  expect(starts.at(2)! - starts.at(1)!).toBe(TIMING.idleSleepMs);
  expect(starts.at(3)! - starts.at(2)!).toBe(TIMING.idleSleepMs * 2);
});

test("a settled turn resets the idle backoff", async () => {
  const { events } = await runDrain({
    steps: [DRAINED, DRAINED, settled(1), DRAINED],
    turns: 5,
  });
  const starts = batchStarts(events);
  expect(starts.at(2)! - starts.at(1)!).toBe(TIMING.idleSleepMs * 2);
  // The settled turn pays the duty cycle and puts the idle floor back.
  expect(starts.at(3)! - starts.at(2)!).toBe(TIMING.batchDelayMs);
  expect(starts.at(4)! - starts.at(3)!).toBe(TIMING.idleSleepMs);
});

test("a held walk waits instead of spinning", async () => {
  const { events, saved } = await runDrain({ steps: [BUSY], turns: 3 });
  const starts = batchStarts(events);
  expect(starts.at(1)! - starts.at(0)!).toBe(TIMING.idleSleepMs);
  // Another writer's position is not this process's to overwrite.
  expect(saved).toEqual([null, null, null]);
});

test("a throwing batch backs off and the walk continues", async () => {
  const { events, summaries } = await runDrain({
    steps: ["throw"],
    turns: 4,
  });
  const starts = batchStarts(events);
  expect(starts.at(1)! - starts.at(0)!).toBe(TIMING.batchDelayMs * 2);
  expect(starts.at(2)! - starts.at(1)!).toBe(TIMING.batchDelayMs * 4);
  expect(summaries.at(-1)).toMatchObject({ errored: 4, lastErrorTag: "Error" });
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
        cursor: cursorAt(1),
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
  const { summaries } = await runDrain({ steps: [settled(1)], turns: 2 });
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
