/**
 * The gate decides who is asked, and both ways of getting it wrong are
 * quiet: asking every publisher on every restart looks like a healthy
 * sweep, and asking nobody looks like a corpus whose totals never change.
 */

import { describe, expect, test } from "bun:test";

import { SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import type { SourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { SourceAdapter } from "@/api/lib/legal-search/ingestion-types";

import {
  SOURCE_TOTAL_POLL_OUTCOME,
  SOURCE_TOTAL_STALE_AFTER_MS,
  selectCountingAdapters,
  selectStaleCountingAdapters,
  tallySourceTotalPollOutcomes,
  type SourceTotalPollOutcome,
} from "./source-total-outcomes";

const adapter = (
  key: SourceAdapter["key"],
  getTotalCount?: SourceAdapter["getTotalCount"],
): SourceAdapter => ({
  key,
  name: `${key} fixture`,
  country: "CZ",
  language: "cs",
  minRequestIntervalMs: 1000,
  fetchPage: () => {
    throw new Error("fetchPage is not exercised by outcome selection");
  },
  ...(getTotalCount && { getTotalCount }),
});

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const recorded = (
  adapterKey: SourceAdapter["key"],
  reportedTotalAsOf: Date | null,
): SourceReportedTotal => ({
  adapterKey,
  reportedTotal: reportedTotalAsOf === null ? null : 1234,
  reportedTotalAsOf,
  reportedTotalOrigin:
    reportedTotalAsOf === null ? null : SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
});

describe("selectCountingAdapters", () => {
  test("asks by capability, so a new implementer joins on its own", () => {
    const counting = adapter(ADAPTER_KEYS.CZ_US, async () => 42);
    const alsoCounting = adapter(ADAPTER_KEYS.PL_COURTS, async () => null);
    const silent = adapter(ADAPTER_KEYS.CZ_NS);

    expect(
      selectCountingAdapters([counting, silent, alsoCounting]).map(
        ({ key }) => key,
      ),
    ).toEqual([ADAPTER_KEYS.CZ_US, ADAPTER_KEYS.PL_COURTS]);
  });

  test("an adapter stating no count is never probed", () => {
    expect(selectCountingAdapters([adapter(ADAPTER_KEYS.CZ_NS)])).toEqual([]);
  });
});

const czUs = adapter(ADAPTER_KEYS.CZ_US, async () => 1);
const czRegional = adapter(ADAPTER_KEYS.CZ_REGIONAL, async () => 2);

describe("selectStaleCountingAdapters", () => {
  const capable = [czUs, czRegional];

  test("a restart does not re-ask a publisher that answered recently", () => {
    // The defect this pins: a wake-interval timer would poll every
    // publisher on every deployment, which no failure surfaces.
    const totals = [
      recorded(ADAPTER_KEYS.CZ_US, new Date(NOW - DAY_IN_MS)),
      recorded(ADAPTER_KEYS.CZ_REGIONAL, new Date(NOW - 5 * DAY_IN_MS)),
    ];

    expect(
      selectStaleCountingAdapters({
        adapters: capable,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals,
      }),
    ).toEqual([]);
  });

  test("a total older than the window is asked again", () => {
    const totals = [
      recorded(ADAPTER_KEYS.CZ_US, new Date(NOW - SOURCE_TOTAL_STALE_AFTER_MS)),
      recorded(ADAPTER_KEYS.CZ_REGIONAL, new Date(NOW - DAY_IN_MS)),
    ];

    expect(
      selectStaleCountingAdapters({
        adapters: capable,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals,
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_US]);
  });

  test("a source never measured, and one with no row at all, are both asked", () => {
    const totals = [recorded(ADAPTER_KEYS.CZ_US, null)];

    expect(
      selectStaleCountingAdapters({
        adapters: capable,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals,
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_US, ADAPTER_KEYS.CZ_REGIONAL]);
  });

  test("a stale total on an adapter that cannot count is not asked", () => {
    expect(
      selectStaleCountingAdapters({
        adapters: [adapter(ADAPTER_KEYS.CZ_NS)],
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals: [recorded(ADAPTER_KEYS.CZ_NS, null)],
      }),
    ).toEqual([]);
  });

  test("a total dated ahead of the clock reads as fresh, not overdue", () => {
    expect(
      selectStaleCountingAdapters({
        adapters: [czUs],
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals: [recorded(ADAPTER_KEYS.CZ_US, new Date(NOW + DAY_IN_MS))],
      }),
    ).toEqual([]);
  });
});

describe("tallySourceTotalPollOutcomes", () => {
  test("every declared outcome lands in exactly one counter", () => {
    // Both directions: an outcome the tally forgot would leave the sweep
    // uncounted, and a counter no outcome reaches would report a number
    // nothing can produce.
    const declared = Object.values(SOURCE_TOTAL_POLL_OUTCOME);

    const counted = declared.map((outcome) => {
      const { polled, ...counters } = tallySourceTotalPollOutcomes([outcome]);
      expect(polled).toBe(1);
      return Object.entries(counters).filter(([, count]) => count === 1);
    });

    expect(counted.map((entries) => entries.length)).toEqual(
      declared.map(() => 1),
    );
    expect(new Set(counted.map((entries) => entries.at(0)?.at(0))).size).toBe(
      declared.length,
    );
  });

  test("the counters account for every polled source", () => {
    const outcomes: SourceTotalPollOutcome[] = [
      SOURCE_TOTAL_POLL_OUTCOME.RECORDED,
      SOURCE_TOTAL_POLL_OUTCOME.RECORDED,
      SOURCE_TOTAL_POLL_OUTCOME.NO_COUNT,
      SOURCE_TOTAL_POLL_OUTCOME.FAILED,
      SOURCE_TOTAL_POLL_OUTCOME.UNKNOWN_SOURCE,
      SOURCE_TOTAL_POLL_OUTCOME.FAILED,
    ];

    const tally = tallySourceTotalPollOutcomes(outcomes);

    expect(tally).toEqual({
      polled: 6,
      recorded: 2,
      noCount: 1,
      failed: 2,
      unknownSource: 1,
    });
    expect(
      tally.recorded + tally.noCount + tally.failed + tally.unknownSource,
    ).toBe(tally.polled);
  });

  test("an empty sweep reports zero polled, not an absent number", () => {
    expect(tallySourceTotalPollOutcomes([])).toEqual({
      polled: 0,
      recorded: 0,
      noCount: 0,
      failed: 0,
      unknownSource: 0,
    });
  });
});
