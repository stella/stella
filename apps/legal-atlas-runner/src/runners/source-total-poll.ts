/**
 * The standing sweep over the totals publishers report holding.
 *
 * Held-vs-total coverage needs a denominator, and only some publishers
 * expose a cheap count. Every adapter is asked, and answers with the count,
 * with "my publisher exposes none", or with the probe that failed; where a
 * publisher exposes none, an operator records its own stated figure, with the
 * origin kept alongside so a reader can tell a measured number from a
 * transcribed one.
 *
 * What decides a sweep is when each source was last recorded or asked, not
 * an interval this process has been awake for. The wake is frequent and
 * cheap; that gate is what makes the cadence weekly, and it is the reason a
 * deployment neither loses a cycle nor re-asks every publisher on boot.
 *
 * A probe that yields no usable number records NOTHING. The stored total is
 * the last figure a publisher actually stated, and a failed probe is not
 * evidence that it changed.
 *
 * Kept free of the runner's DB, env and process imports so the gate and the
 * pacing can be exercised on their own.
 */

import { panic } from "better-result";

import type { SourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import { errorTag } from "@/api/lib/errors/error-tag";
import type {
  SourceAdapter,
  SourceTotalCount,
} from "@/api/lib/legal-search/ingestion-types";

import { DRAIN_CHECK_SLICE_MS } from "./sk-document-drain";
import {
  SOURCE_TOTAL_POLL_OUTCOME,
  SOURCE_TOTAL_STALE_AFTER_MS,
  type SourceTotalPollOutcome,
  type SourceTotalPollTally,
  selectDueCountingAdapters,
  tallySourceTotalPollOutcomes,
} from "./source-total-outcomes";

export type SourceTotalPollSummary = SourceTotalPollTally & {
  /**
   * The most recent failure's structural tag, so an error rate has a cause
   * beside it. A tag rather than the error, reduced here rather than at the
   * sink: a message can carry more than an operator asked to see, and a
   * summary that never holds one cannot leak one.
   */
  lastErrorTag: string | undefined;
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

type ProbedSourceTotal = {
  adapter: SourceAdapter;
  count: SourceTotalCount;
};

type SettledSourceTotal = {
  outcome: SourceTotalPollOutcome;
  errorTag: string | undefined;
};

type ProbeSourceTotalOptions = {
  adapter: SourceAdapter;
  timeoutMs: number;
};

/**
 * One probe against one publisher.
 *
 * The adapter classifies its own answer, so a publisher that states no total
 * and a request that broke arrive here already apart; a throw is this probe's
 * own failure and joins the second.
 */
const probeSourceTotal = async ({
  adapter,
  timeoutMs,
}: ProbeSourceTotalOptions): Promise<ProbedSourceTotal> => {
  try {
    return {
      adapter,
      count: await adapter.getTotalCount(AbortSignal.timeout(timeoutMs)),
    };
  } catch (error) {
    return {
      adapter,
      count: { type: "probe-failed", errorTag: errorTag(error) },
    };
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
  probed: { adapter, count },
  recordTotal,
}: RecordProbedTotalOptions): Promise<SettledSourceTotal> => {
  switch (count.type) {
    case "no-count-endpoint": {
      return {
        outcome: SOURCE_TOTAL_POLL_OUTCOME.NO_COUNT,
        errorTag: undefined,
      };
    }
    case "probe-failed": {
      return {
        outcome: SOURCE_TOTAL_POLL_OUTCOME.FAILED,
        errorTag: count.errorTag,
      };
    }
    case "count": {
      try {
        const applied = await recordTotal({
          adapterKey: adapter.key,
          asOf,
          total: count.total,
        });

        // An adapter the sources table does not carry is registry drift: the
        // number is unattributable, so it is counted and reported rather
        // than dropped.
        return {
          outcome: applied
            ? SOURCE_TOTAL_POLL_OUTCOME.RECORDED
            : SOURCE_TOTAL_POLL_OUTCOME.UNKNOWN_SOURCE,
          errorTag: undefined,
        };
      } catch (error) {
        return {
          outcome: SOURCE_TOTAL_POLL_OUTCOME.FAILED,
          errorTag: errorTag(error),
        };
      }
    }
    default: {
      count satisfies never;
      return panic(`unhandled source-total answer: ${JSON.stringify(count)}`);
    }
  }
};

type SweepOptions = Omit<SourceTotalPollOptions, "report" | "sleep"> & {
  /** Written as each source is asked, so the gate can run off the ask. */
  askedAt: Map<string, number>;
};

/**
 * One wake. Returns null when there was nothing to say: every total fresh,
 * or a drain that arrived before anything was written.
 */
const sweepSourceTotals = async ({
  adapters,
  askedAt,
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
    return {
      ...tallySourceTotalPollOutcomes([]),
      lastErrorTag: errorTag(error),
    };
  }

  const askedAtSweepStart = now();
  const due = selectDueCountingAdapters({
    adapters,
    askedAt,
    now: askedAtSweepStart,
    staleAfterMs: timing.staleAfterMs,
    totals,
  });
  if (due.length === 0) {
    return null;
  }

  // Recorded before the probes, not after: a source that answers nothing has
  // still been asked, and that is what the next gate must see.
  for (const { key } of due) {
    askedAt.set(key, askedAtSweepStart);
  }

  // One request per publisher, each a different host, so the sweep runs them
  // together rather than serializing behind the slowest count.
  const probed = await Promise.all(
    due.map(
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

  let lastErrorTag: string | undefined;
  for (const settledTotal of settled) {
    if (settledTotal.errorTag !== undefined) {
      lastErrorTag = settledTotal.errorTag;
    }
  }

  return {
    ...tallySourceTotalPollOutcomes(settled.map(({ outcome }) => outcome)),
    lastErrorTag,
  };
};

/**
 * Sweep until the process drains.
 *
 * The first sweep runs before the first sleep, which is what lets a source
 * that has never been measured be filled on the next deployment instead of
 * a wake later. The recorded date is what keeps that from re-asking every
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
  // Per process: the persisted date is what survives a restart, this only
  // keeps a source that persists nothing from being asked every wake.
  const askedAt = new Map<string, number>();

  while (!isDraining()) {
    const summary = await sweepSourceTotals({
      adapters,
      askedAt,
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
      await sleep(sliceMs);
      remainingMs -= sliceMs;
    }
  }
};
