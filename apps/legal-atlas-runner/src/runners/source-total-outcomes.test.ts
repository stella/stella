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
  selectDueCountingAdapters,
  tallySourceTotalPollOutcomes,
  type SourceTotalPollOutcome,
} from "./source-total-outcomes";

const adapter = (
  key: SourceAdapter["key"],
  getTotalCount: SourceAdapter["getTotalCount"] = async () => ({
    type: "no-count-endpoint",
  }),
): SourceAdapter => ({
  key,
  name: `${key} fixture`,
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 1000,
  fetchPage: () => {
    throw new Error("fetchPage is not exercised by outcome selection");
  },
  getTotalCount,
  reconciliation: {
    type: "unsupported",
    reason: "fixture: outcome selection never reconciles",
  },
});

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const NEVER_ASKED: ReadonlyMap<string, number> = new Map();

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

describe("selectDueCountingAdapters", () => {
  test("asks every adapter, because every adapter can be asked", () => {
    // The capability is required, so the sweep no longer selects on it: an
    // adapter is either due or fresh, never exempt.
    const adapters = [
      adapter(ADAPTER_KEYS.CZ_US, async () => ({ type: "count", total: 42 })),
      adapter(ADAPTER_KEYS.CZ_NS),
      adapter(ADAPTER_KEYS.PL_COURTS, async () => ({
        type: "no-count-endpoint",
      })),
    ];

    expect(
      selectDueCountingAdapters({
        adapters,
        askedAt: NEVER_ASKED,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals: [],
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_US, ADAPTER_KEYS.CZ_NS, ADAPTER_KEYS.PL_COURTS]);
  });
});

const czUs = adapter(ADAPTER_KEYS.CZ_US, async () => ({
  type: "count",
  total: 1,
}));
const czRegional = adapter(ADAPTER_KEYS.CZ_REGIONAL, async () => ({
  type: "count",
  total: 2,
}));

describe("selectDueCountingAdapters", () => {
  const capable = [czUs, czRegional];

  test("a restart does not re-ask a publisher that answered recently", () => {
    // The defect this pins: a wake-interval timer would poll every
    // publisher on every deployment, which no failure surfaces.
    const totals = [
      recorded(ADAPTER_KEYS.CZ_US, new Date(NOW - DAY_IN_MS)),
      recorded(ADAPTER_KEYS.CZ_REGIONAL, new Date(NOW - 5 * DAY_IN_MS)),
    ];

    expect(
      selectDueCountingAdapters({
        adapters: capable,
        askedAt: NEVER_ASKED,
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
      selectDueCountingAdapters({
        adapters: capable,
        askedAt: NEVER_ASKED,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals,
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_US]);
  });

  test("a source never measured, and one with no row at all, are both asked", () => {
    const totals = [recorded(ADAPTER_KEYS.CZ_US, null)];

    expect(
      selectDueCountingAdapters({
        adapters: capable,
        askedAt: NEVER_ASKED,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals,
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_US, ADAPTER_KEYS.CZ_REGIONAL]);
  });

  test("a source carrying a row but no measurement is asked", () => {
    // A row with a null date and a source with no row are the same case: the
    // publisher has never stated a total, so the sweep has to ask.
    expect(
      selectDueCountingAdapters({
        adapters: [adapter(ADAPTER_KEYS.CZ_NS)],
        askedAt: NEVER_ASKED,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals: [recorded(ADAPTER_KEYS.CZ_NS, null)],
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_NS]);
  });

  test("a source asked recently is not asked again, whatever it answered", () => {
    // Neither a publisher that exposes no count nor a request that failed
    // persists a date. Gating on the recorded date alone would re-ask those
    // sources every wake, hours apart, which no failure surfaces.
    expect(
      selectDueCountingAdapters({
        adapters: capable,
        askedAt: new Map([
          [ADAPTER_KEYS.CZ_US, NOW - DAY_IN_MS],
          [ADAPTER_KEYS.CZ_REGIONAL, NOW - SOURCE_TOTAL_STALE_AFTER_MS],
        ]),
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals: [
          recorded(ADAPTER_KEYS.CZ_US, null),
          recorded(ADAPTER_KEYS.CZ_REGIONAL, null),
        ],
      }).map(({ key }) => key),
    ).toEqual([ADAPTER_KEYS.CZ_REGIONAL]);
  });

  test("a recorded total still gates a source this process never asked", () => {
    // The ask memory is per process; a restart must not undo the cadence a
    // recorded date already proves.
    expect(
      selectDueCountingAdapters({
        adapters: capable,
        askedAt: NEVER_ASKED,
        now: NOW,
        staleAfterMs: SOURCE_TOTAL_STALE_AFTER_MS,
        totals: [
          recorded(ADAPTER_KEYS.CZ_US, new Date(NOW - DAY_IN_MS)),
          recorded(ADAPTER_KEYS.CZ_REGIONAL, new Date(NOW - DAY_IN_MS)),
        ],
      }),
    ).toEqual([]);
  });

  test("a total dated ahead of the clock reads as fresh, not overdue", () => {
    expect(
      selectDueCountingAdapters({
        adapters: [czUs],
        askedAt: NEVER_ASKED,
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
