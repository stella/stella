/**
 * The standing sweep over the totals publishers report holding.
 *
 * Held-vs-total coverage needs a denominator, and only some publishers
 * expose a cheap count. Those adapters implement `getTotalCount` and are
 * asked here; for the rest an operator records the publisher's own figure,
 * with the origin kept alongside so a reader can tell a measured number
 * from a transcribed one.
 *
 * What decides a sweep is the recorded date, not an interval this process
 * has been awake for. The wake is frequent and cheap; the staleness gate is
 * what makes the cadence weekly, and it is the reason a deployment neither
 * loses a cycle nor re-asks every publisher on boot.
 *
 * A probe that yields no usable number records NOTHING. The stored total is
 * the last figure a publisher actually stated, and a failed probe is not
 * evidence that it changed.
 *
 * Kept free of the runner's DB, env and process imports so the gate and the
 * pacing can be exercised on their own.
 */

import type { SourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import type { SourceAdapter } from "@/api/lib/legal-search/ingestion-types";

import { DRAIN_CHECK_SLICE_MS } from "./sk-document-drain";
import {
  SOURCE_TOTAL_POLL_OUTCOME,
  SOURCE_TOTAL_STALE_AFTER_MS,
  type CountingSourceAdapter,
  type SourceTotalPollOutcome,
  type SourceTotalPollTally,
  selectStaleCountingAdapters,
  tallySourceTotalPollOutcomes,
} from "./source-total-outcomes";

export type SourceTotalPollSummary = SourceTotalPollTally & {
  /**
   * The most recent throw, so an error rate has a cause beside it. Left
   * raw: the caller renders it, and it renders a tag rather than a message,
   * because a message can carry more than an operator asked to see.
   */
  lastError: unknown;
};

export type SourceTotalPollTiming = {
  /** Gap between two staleness checks. Most of them ask nobody anything. */
  wakeIntervalMs: number;
  /** Age at which a recorded total is asked for again. */
  staleAfterMs: number;
  /** Per-probe budget. Publishers compute a full-range count slowly. */
  probeTimeoutMs: number;
};

export const SOURCE_TOTAL_POLL_TIMING = {
  // Well under the staleness window, so the effective cadence is the window
  // rather than the wake: a total that falls due is refreshed within hours,
  // and the checks in between cost one bounded read.
  wakeIntervalMs: 6 * 60 * 60 * 1000,
  staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
  probeTimeoutMs: 120_000,
} as const satisfies SourceTotalPollTiming;

export type RecordSourceTotalOptions = {
  adapterKey: string;
  asOf: Date;
  total: number;
};

export type SourceTotalPollOptions = {
  adapters: readonly SourceAdapter[];
  /** Stops the sweep without abandoning the probe already in flight. */
  isDraining: () => boolean;
  now: () => number;
  readTotals: () => Promise<readonly SourceReportedTotal[]>;
  /** Records one total; false when no source carries the adapter key. */
  recordTotal: (options: RecordSourceTotalOptions) => Promise<boolean>;
  /** Receives the tallies of a sweep that asked somebody. */
  report: (summary: SourceTotalPollSummary) => void;
  sleep: (ms: number) => Promise<void>;
  timing: SourceTotalPollTiming;
};

type SourceTotalProbe =
  | { status: "counted"; total: number }
  | { status: "no-count" }
  | { status: "failed"; error: unknown };

type ProbedSourceTotal = {
  adapter: CountingSourceAdapter;
  probe: SourceTotalProbe;
};

type SettledSourceTotal = {
  outcome: SourceTotalPollOutcome;
  error: unknown;
};

type ProbeSourceTotalOptions = {
  adapter: CountingSourceAdapter;
  timeoutMs: number;
};

/**
 * One probe against one publisher. A throw is a failure of this probe; a
 * null is the adapter's own answer that its publisher states no total, so
 * the two are kept apart rather than collapsed into "no number".
 */
const probeSourceTotal = async ({
  adapter,
  timeoutMs,
}: ProbeSourceTotalOptions): Promise<ProbedSourceTotal> => {
  try {
    const total = await adapter.getTotalCount(AbortSignal.timeout(timeoutMs));

    return {
      adapter,
      probe:
        total === null ? { status: "no-count" } : { status: "counted", total },
    };
  } catch (error) {
    return { adapter, probe: { status: "failed", error } };
  }
};

type RecordProbedTotalOptions = {
  asOf: Date;
  probed: ProbedSourceTotal;
  recordTotal: (options: RecordSourceTotalOptions) => Promise<boolean>;
};

/**
 * Persist one probed count, or account for why none was persisted. The
 * writer owns what counts as a usable number, so its rules are not restated
 * here — but its rejection must not escape: the probes settle together, and
 * a throw would lose the result of every other source in the sweep.
 */
const recordProbedTotal = async ({
  asOf,
  probed: { adapter, probe },
  recordTotal,
}: RecordProbedTotalOptions): Promise<SettledSourceTotal> => {
  switch (probe.status) {
    case "no-count": {
      return { outcome: SOURCE_TOTAL_POLL_OUTCOME.NO_COUNT, error: undefined };
    }
    case "failed": {
      return { outcome: SOURCE_TOTAL_POLL_OUTCOME.FAILED, error: probe.error };
    }
    case "counted": {
      try {
        const applied = await recordTotal({
          adapterKey: adapter.key,
          asOf,
          total: probe.total,
        });

        // An adapter the sources table does not carry is registry drift: the
        // number is unattributable, so it is counted and reported rather
        // than dropped.
        return {
          outcome: applied
            ? SOURCE_TOTAL_POLL_OUTCOME.RECORDED
            : SOURCE_TOTAL_POLL_OUTCOME.UNKNOWN_SOURCE,
          error: undefined,
        };
      } catch (error) {
        return { outcome: SOURCE_TOTAL_POLL_OUTCOME.FAILED, error };
      }
    }
    default: {
      const exhaustive: never = probe;
      return {
        outcome: SOURCE_TOTAL_POLL_OUTCOME.FAILED,
        error: new Error(
          `unhandled source-total probe: ${JSON.stringify(exhaustive)}`,
        ),
      };
    }
  }
};

type SweepOptions = Omit<SourceTotalPollOptions, "report" | "sleep">;

/**
 * One wake. Returns null when there was nothing to say: every total fresh,
 * or a drain that arrived before anything was written.
 */
const sweepSourceTotals = async ({
  adapters,
  isDraining,
  now,
  readTotals,
  recordTotal,
  timing,
}: SweepOptions): Promise<SourceTotalPollSummary | null> => {
  let totals: readonly SourceReportedTotal[];
  try {
    totals = await readTotals();
  } catch (error) {
    // A read that failed is not "everything is fresh", so it is reported
    // rather than passed over in silence.
    return { ...tallySourceTotalPollOutcomes([]), lastError: error };
  }

  const stale = selectStaleCountingAdapters({
    adapters,
    now: now(),
    staleAfterMs: timing.staleAfterMs,
    totals,
  });
  if (stale.length === 0) {
    return null;
  }

  // One request per publisher, each a different host, so the sweep runs them
  // together rather than serializing behind the slowest count.
  const probed = await Promise.all(
    stale.map(
      async (adapter) =>
        await probeSourceTotal({ adapter, timeoutMs: timing.probeTimeoutMs }),
    ),
  );

  // A drain stops the sweep before it writes rather than part-way through
  // it: a run that was cut short states nothing about the totals it read.
  if (isDraining()) {
    return null;
  }

  const asOf = new Date(now());
  const settled = await Promise.all(
    probed.map(
      async (probe) =>
        await recordProbedTotal({ asOf, probed: probe, recordTotal }),
    ),
  );

  let lastError: unknown;
  for (const { error } of settled) {
    if (error !== undefined) {
      lastError = error;
    }
  }

  return {
    ...tallySourceTotalPollOutcomes(settled.map(({ outcome }) => outcome)),
    lastError,
  };
};

/**
 * Sweep until the process drains.
 *
 * The first sweep runs before the first sleep, which is what lets a source
 * that has never been measured be filled on the next deployment instead of
 * a wake later. The staleness gate is what keeps that from re-asking every
 * publisher each time the daemon restarts.
 */
export const runSourceTotalPoll = async ({
  adapters,
  isDraining,
  now,
  readTotals,
  recordTotal,
  report,
  sleep,
  timing,
}: SourceTotalPollOptions): Promise<void> => {
  while (!isDraining()) {
    // oxlint-disable-next-line no-await-in-loop -- one sweep per wake; the interval only starts once this sweep has settled
    const summary = await sweepSourceTotals({
      adapters,
      isDraining,
      now,
      readTotals,
      recordTotal,
      timing,
    });
    if (summary !== null) {
      report(summary);
    }

    // Sliced so a drain request interrupts an interval of hours within a
    // second.
    let remainingMs = timing.wakeIntervalMs;
    while (remainingMs > 0 && !isDraining()) {
      const sliceMs = Math.min(remainingMs, DRAIN_CHECK_SLICE_MS);
      // oxlint-disable-next-line no-await-in-loop -- sequential wait, sliced only to re-check the drain flag
      await sleep(sliceMs);
      remainingMs -= sliceMs;
    }
  }
};
