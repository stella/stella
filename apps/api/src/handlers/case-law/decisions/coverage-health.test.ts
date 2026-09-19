import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_COVERAGE_HEALTH,
  CASE_LAW_TOTAL_REPORTER,
  caseLawCountryCompleteness,
  caseLawCountryHealth,
  caseLawSourceCompleteness,
  caseLawSourceHealth,
  COVERAGE_CURRENT_WITHIN_MS,
  COVERAGE_DELAYED_WITHIN_MS,
  COVERAGE_REPORTED_TOTAL_FRESH_WITHIN_MS,
  type CaseLawSourceCompleteness,
} from "@/api/handlers/case-law/decisions/coverage-health";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("source health", () => {
  test("a source that synced on time is current however little it found", () => {
    expect(
      caseLawSourceHealth({ enabled: true, lastSyncAt: ago(0), now: NOW }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.CURRENT);
  });

  test("the current window includes its own boundary and excludes the next millisecond", () => {
    expect(
      caseLawSourceHealth({
        enabled: true,
        lastSyncAt: ago(COVERAGE_CURRENT_WITHIN_MS),
        now: NOW,
      }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.CURRENT);
    expect(
      caseLawSourceHealth({
        enabled: true,
        lastSyncAt: ago(COVERAGE_CURRENT_WITHIN_MS + 1),
        now: NOW,
      }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.DELAYED);
  });

  test("the delayed window includes its own boundary and stalls past it", () => {
    expect(
      caseLawSourceHealth({
        enabled: true,
        lastSyncAt: ago(COVERAGE_DELAYED_WITHIN_MS),
        now: NOW,
      }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.DELAYED);
    expect(
      caseLawSourceHealth({
        enabled: true,
        lastSyncAt: ago(COVERAGE_DELAYED_WITHIN_MS + 1),
        now: NOW,
      }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.STALLED);
  });

  test("a disabled source is paused whatever its last sync says", () => {
    expect(
      caseLawSourceHealth({
        enabled: false,
        lastSyncAt: ago(COVERAGE_DELAYED_WITHIN_MS * 10),
        now: NOW,
      }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.PAUSED);
    expect(
      caseLawSourceHealth({ enabled: false, lastSyncAt: NOW, now: NOW }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.PAUSED);
  });

  test("a source that has never synced is unknown, not stalled", () => {
    expect(
      caseLawSourceHealth({ enabled: true, lastSyncAt: null, now: NOW }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.UNKNOWN);
  });

  test("a sync stamped ahead of now reads as current rather than as a negative age", () => {
    expect(
      caseLawSourceHealth({
        enabled: true,
        lastSyncAt: new Date(NOW.getTime() + COVERAGE_DELAYED_WITHIN_MS),
        now: NOW,
      }),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.CURRENT);
  });
});

describe("country health", () => {
  test("one stalled source is visible past working siblings", () => {
    expect(
      caseLawCountryHealth([
        CASE_LAW_COVERAGE_HEALTH.CURRENT,
        CASE_LAW_COVERAGE_HEALTH.CURRENT,
        CASE_LAW_COVERAGE_HEALTH.STALLED,
      ]),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.STALLED);
  });

  test("a paused source does not outrank a working one", () => {
    expect(
      caseLawCountryHealth([
        CASE_LAW_COVERAGE_HEALTH.PAUSED,
        CASE_LAW_COVERAGE_HEALTH.CURRENT,
      ]),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.CURRENT);
  });

  test("a country whose every source is paused is paused", () => {
    expect(
      caseLawCountryHealth([
        CASE_LAW_COVERAGE_HEALTH.PAUSED,
        CASE_LAW_COVERAGE_HEALTH.PAUSED,
      ]),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.PAUSED);
  });

  test("a country with no sources is unknown", () => {
    expect(caseLawCountryHealth([])).toBe(CASE_LAW_COVERAGE_HEALTH.UNKNOWN);
  });

  test("an unknown source outranks a current one but not a delayed one", () => {
    expect(
      caseLawCountryHealth([
        CASE_LAW_COVERAGE_HEALTH.CURRENT,
        CASE_LAW_COVERAGE_HEALTH.UNKNOWN,
      ]),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.UNKNOWN);
    expect(
      caseLawCountryHealth([
        CASE_LAW_COVERAGE_HEALTH.UNKNOWN,
        CASE_LAW_COVERAGE_HEALTH.DELAYED,
      ]),
    ).toBe(CASE_LAW_COVERAGE_HEALTH.DELAYED);
  });
});

describe("source completeness", () => {
  const measured = {
    reportedTotal: 1000,
    reportedTotalAsOf: ago(0),
    reportedBy: CASE_LAW_TOTAL_REPORTER.PUBLISHER,
    stored: { precision: "exact", decisions: 950 },
    now: NOW,
  } as const;

  test("a source with a fresh total and a count is measured", () => {
    expect(caseLawSourceCompleteness(measured)).toEqual({
      state: "measured",
      stored: { precision: "exact", decisions: 950 },
      reported: 1000,
      asOf: NOW.toISOString(),
      reportedBy: CASE_LAW_TOTAL_REPORTER.PUBLISHER,
    });
  });

  test("the freshness window includes its own boundary and goes stale past it", () => {
    expect(
      caseLawSourceCompleteness({
        ...measured,
        reportedTotalAsOf: ago(COVERAGE_REPORTED_TOTAL_FRESH_WITHIN_MS),
      }).state,
    ).toBe("measured");
    expect(
      caseLawSourceCompleteness({
        ...measured,
        reportedTotalAsOf: ago(COVERAGE_REPORTED_TOTAL_FRESH_WITHIN_MS + 1),
      }).state,
    ).toBe("stale");
  });

  test("a source nobody has measured says so rather than reporting zero", () => {
    expect(
      caseLawSourceCompleteness({
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedBy: null,
        stored: { precision: "exact", decisions: 950 },
        now: NOW,
      }),
    ).toEqual({ state: "not-measured-yet" });
  });

  test("a total with no stored count withholds the ratio instead of guessing", () => {
    expect(caseLawSourceCompleteness({ ...measured, stored: null })).toEqual({
      state: "count-unavailable",
      reported: 1000,
      asOf: NOW.toISOString(),
    });
  });

  test("an operator-supplied total is carried as such", () => {
    const completeness = caseLawSourceCompleteness({
      ...measured,
      reportedBy: CASE_LAW_TOTAL_REPORTER.OPERATOR,
    });
    expect(completeness).toMatchObject({
      state: "measured",
      reportedBy: CASE_LAW_TOTAL_REPORTER.OPERATOR,
    });
  });

  test("a corpus past its counting bound is reported as a floor", () => {
    expect(
      caseLawSourceCompleteness({
        ...measured,
        stored: { precision: "at-least", decisions: 500_000 },
      }),
    ).toMatchObject({ stored: { precision: "at-least", decisions: 500_000 } });
  });
});

describe("country completeness", () => {
  const exact = (decisions: number, reported: number) =>
    ({
      state: "measured",
      stored: { precision: "exact", decisions },
      reported,
      asOf: NOW.toISOString(),
      reportedBy: CASE_LAW_TOTAL_REPORTER.PUBLISHER,
    }) satisfies CaseLawSourceCompleteness;

  test("only measured sources are summed and the rest are counted beside the sum", () => {
    expect(
      caseLawCountryCompleteness([
        exact(100, 120),
        exact(50, 50),
        { state: "not-measured-yet" },
        { state: "count-unavailable", reported: 900, asOf: NOW.toISOString() },
      ]),
    ).toEqual({
      measuredSources: 2,
      stored: 150,
      reported: 170,
      storedPrecision: "exact",
      staleSources: 0,
      unmeasuredSources: 1,
      uncountedSources: 1,
    });
  });

  test("a stale source is summed and counted as stale", () => {
    expect(
      caseLawCountryCompleteness([
        { ...exact(10, 10), state: "stale" },
        exact(5, 5),
      ]),
    ).toMatchObject({ measuredSources: 2, stored: 15, staleSources: 1 });
  });

  test("one bounded count makes the whole sum a floor", () => {
    expect(
      caseLawCountryCompleteness([
        exact(10, 10),
        {
          ...exact(500_000, 600_000),
          stored: { precision: "at-least", decisions: 500_000 },
        },
      ]).storedPrecision,
    ).toBe("at-least");
  });

  test("a country holding only unmeasured sources reports no ratio at all", () => {
    expect(
      caseLawCountryCompleteness([
        { state: "not-measured-yet" },
        { state: "not-measured-yet" },
      ]),
    ).toEqual({
      measuredSources: 0,
      stored: 0,
      reported: 0,
      storedPrecision: "exact",
      staleSources: 0,
      unmeasuredSources: 2,
      uncountedSources: 0,
    });
  });

  // The API states the counts and never a ratio: a publisher total that lags
  // the corpus leaves stored above reported, and capping that here would hide
  // the lag from every reader instead of only from the percentage.
  test("a stored count above the publisher total survives the roll-up unchanged", () => {
    const { reported, stored } = caseLawCountryCompleteness([exact(120, 100)]);
    expect(stored).toBe(120);
    expect(reported).toBe(100);
  });
});
