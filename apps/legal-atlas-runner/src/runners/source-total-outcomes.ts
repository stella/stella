/**
 * Which sources a totals sweep should ask, and how the answers are counted.
 *
 * Kept free of the runner's DB, clock and process imports so the selection
 * and the arithmetic can be exercised on their own: the loop owns the I/O,
 * this module owns the decisions.
 */

import { panic } from "better-result";

import type { SourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import type { SourceAdapter } from "@/api/lib/legal-search/ingestion-types";

/**
 * A plain 24-hour day. The window below is an elapsed duration, not
 * calendar arithmetic, so no DST-aware helper applies. Spelled out here
 * rather than taken from `@stll/time`, which this package does not depend
 * on.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old a recorded total may be before its source is asked again.
 *
 * The gate is the recorded date, not an in-process timer, so a restart
 * neither loses the cadence nor repeats the sweep: a deployment an hour
 * after a poll finds every total fresh and asks nobody. Set below the
 * effective weekly cadence it produces, so a wake that lands slightly early
 * still refreshes rather than deferring a whole extra interval.
 */
export const SOURCE_TOTAL_STALE_AFTER_MS = 6 * DAY_MS;

export const SOURCE_TOTAL_POLL_OUTCOME = {
  /** The publisher stated a number and it is now the recorded total. */
  RECORDED: "recorded",
  /**
   * The publisher exposes no readable count, which `getTotalCount` reports as
   * null. Not a failure: a sweep over sources that never state a total would
   * otherwise always end in one.
   */
  NO_COUNT: "no-count",
  /** The probe or the write did not complete. Nothing was recorded. */
  FAILED: "failed",
  /** The adapter has no source row: registry drift, never silent. */
  UNKNOWN_SOURCE: "unknown-source",
} as const;

export type SourceTotalPollOutcome =
  (typeof SOURCE_TOTAL_POLL_OUTCOME)[keyof typeof SOURCE_TOTAL_POLL_OUTCOME];

export type SourceTotalPollTally = {
  polled: number;
  recorded: number;
  noCount: number;
  failed: number;
  unknownSource: number;
};

/** An adapter whose publisher exposes a count it can read. */
export type CountingSourceAdapter = SourceAdapter & {
  getTotalCount: NonNullable<SourceAdapter["getTotalCount"]>;
};

/**
 * The adapters worth asking at all, by capability rather than by name. An
 * adapter that starts implementing `getTotalCount` joins the sweep on its
 * own; a hand-kept list would leave it out and report nothing about the
 * omission.
 */
export const selectCountingAdapters = (
  adapters: readonly SourceAdapter[],
): CountingSourceAdapter[] =>
  adapters.filter(
    (adapter): adapter is CountingSourceAdapter =>
      adapter.getTotalCount !== undefined,
  );

type SelectStaleCountingAdaptersOptions = {
  adapters: readonly SourceAdapter[];
  /** The sweep's clock, in ms. */
  now: number;
  staleAfterMs: number;
  totals: readonly SourceReportedTotal[];
};

/**
 * The adapters to ask on this wake: those that can answer and whose recorded
 * total is missing or old enough.
 *
 * A source carrying no row and one never measured are the same case, so both
 * are asked. A total dated in the future (a clock that ran backwards, an
 * operator's forward-dated figure) reads as fresh rather than as overdue.
 */
export const selectStaleCountingAdapters = ({
  adapters,
  now,
  staleAfterMs,
  totals,
}: SelectStaleCountingAdaptersOptions): CountingSourceAdapter[] => {
  const recordedAt = new Map(
    totals.map(({ adapterKey, reportedTotalAsOf }) => [
      adapterKey,
      reportedTotalAsOf,
    ]),
  );

  return selectCountingAdapters(adapters).filter((adapter) => {
    const asOf = recordedAt.get(adapter.key) ?? null;
    return asOf === null || now - asOf.getTime() >= staleAfterMs;
  });
};

/** Count a sweep. Every outcome lands in exactly one counter. */
export const tallySourceTotalPollOutcomes = (
  outcomes: readonly SourceTotalPollOutcome[],
): SourceTotalPollTally => {
  const tally: SourceTotalPollTally = {
    polled: outcomes.length,
    recorded: 0,
    noCount: 0,
    failed: 0,
    unknownSource: 0,
  };

  for (const outcome of outcomes) {
    switch (outcome) {
      case SOURCE_TOTAL_POLL_OUTCOME.RECORDED: {
        tally.recorded += 1;
        break;
      }
      case SOURCE_TOTAL_POLL_OUTCOME.NO_COUNT: {
        tally.noCount += 1;
        break;
      }
      case SOURCE_TOTAL_POLL_OUTCOME.FAILED: {
        tally.failed += 1;
        break;
      }
      case SOURCE_TOTAL_POLL_OUTCOME.UNKNOWN_SOURCE: {
        tally.unknownSource += 1;
        break;
      }
      default: {
        const exhaustive: never = outcome;
        return panic(
          `unhandled source-total poll outcome: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  return tally;
};
