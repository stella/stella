/**
 * Which sources a totals sweep should ask, and how the answers are counted.
 *
 * Kept free of the runner's DB, clock and process imports so the selection
 * and the arithmetic can be exercised on their own: the loop owns the I/O,
 * this module owns the decisions.
 */

import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

import type { SourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import type { SourceAdapter } from "@/api/lib/legal-search/ingestion-types";

/**
 * How old a recorded total may be before its source is asked again.
 *
 * The gate is the recorded date, not an in-process timer, so a restart
 * neither loses the cadence nor repeats the sweep: a deployment an hour
 * after a poll finds every total fresh and asks nobody. Set below the
 * effective weekly cadence it produces, so a wake that lands slightly early
 * still refreshes rather than deferring a whole extra interval.
 *
 * An elapsed duration, not calendar arithmetic, so `DAY_IN_MS` applies and
 * no DST-aware helper is needed.
 */
export const SOURCE_TOTAL_STALE_AFTER_MS = 6 * DAY_IN_MS;

export const SOURCE_TOTAL_POLL_OUTCOME = {
  /** The publisher stated a number and it is now the recorded total. */
  RECORDED: "recorded",
  /**
   * The adapter yielded no number. `SourceAdapter.getTotalCount` returns null
   * both for a publisher that exposes no readable count and for a request
   * that failed, and the contract keeps no way to tell them apart, so this
   * cannot mean "the publisher states no total" — only that none was read.
   *
   * Not tallied as a failure: several publishers permanently expose no count,
   * and a sweep over them would otherwise always end in one. What keeps a
   * source that never answers from being re-asked every wake is the ask
   * gate below, not this classification.
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

type SelectDueCountingAdaptersOptions = {
  adapters: readonly SourceAdapter[];
  /** When this process last asked each adapter, whatever it answered. */
  askedAt: ReadonlyMap<string, number>;
  /** The sweep's clock, in ms. */
  now: number;
  staleAfterMs: number;
  totals: readonly SourceReportedTotal[];
};

/**
 * The adapters to ask on this wake: those that can answer, and that have
 * neither been recorded nor asked inside the window.
 *
 * The gate is the last ask, not the last success. A publisher that exposes
 * no count and one whose request failed both come back as null and persist
 * nothing, so a gate on the recorded date alone would ask them again every
 * wake — hours apart rather than the window this loop exists to keep. The
 * ask memory is per process, so a deployment costs one extra attempt for
 * those sources and none for a source that answered.
 *
 * A source carrying no row and one never measured are the same case, so both
 * are asked. A date ahead of the clock (a clock that ran backwards, an
 * operator's forward-dated figure) reads as fresh rather than as overdue.
 */
export const selectDueCountingAdapters = ({
  adapters,
  askedAt,
  now,
  staleAfterMs,
  totals,
}: SelectDueCountingAdaptersOptions): CountingSourceAdapter[] => {
  const recordedAt = new Map(
    totals.map(({ adapterKey, reportedTotalAsOf }) => [
      adapterKey,
      reportedTotalAsOf,
    ]),
  );

  return selectCountingAdapters(adapters).filter((adapter) => {
    const recorded = recordedAt.get(adapter.key)?.getTime();
    const asked = askedAt.get(adapter.key);
    // The later of the two is what the window runs from: a recorded total
    // proves the publisher answered, an ask proves it was given the chance.
    const lastTouched = Math.max(recorded ?? -1, asked ?? -1);
    return lastTouched < 0 || now - lastTouched >= staleAfterMs;
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
