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
    storedTotal: 950,
    storedTotalAsOf: ago(0),
    now: NOW,
  } as const;

  test("a source with both numbers recorded is measured and carries both as-of instants", () => {
    expect(caseLawSourceCompleteness(measured)).toEqual({
      state: "measured",
      stored: 950,
      storedAsOf: NOW.toISOString(),
      reported: 1000,
      reportedAsOf: NOW.toISOString(),
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

  test("staleness is the publisher total's age, not the corpus count's", () => {
    // The corpus count is refreshed by ingestion on its own schedule; an old
    // count does not make the publisher's number out of date.
    expect(
      caseLawSourceCompleteness({
        ...measured,
        storedTotalAsOf: ago(COVERAGE_REPORTED_TOTAL_FRESH_WITHIN_MS * 4),
      }).state,
    ).toBe("measured");
  });

  test("a source nobody has asked the publisher about says so", () => {
    expect(
      caseLawSourceCompleteness({
        ...measured,
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedBy: null,
      }),
    ).toEqual({ state: "not-measured-yet" });
  });

  test("a source whose corpus was never counted is distinct from one never asked about", () => {
    expect(
      caseLawSourceCompleteness({
        ...measured,
        storedTotal: null,
        storedTotalAsOf: null,
      }),
    ).toEqual({ state: "not-counted-yet" });
  });

  test("a counted but empty source reports zero held, not unknown", () => {
    expect(
      caseLawSourceCompleteness({ ...measured, storedTotal: 0 }),
    ).toMatchObject({ state: "measured", stored: 0 });
  });

  test("an operator-supplied total is carried as such", () => {
    expect(
      caseLawSourceCompleteness({
        ...measured,
        reportedBy: CASE_LAW_TOTAL_REPORTER.OPERATOR,
      }),
    ).toMatchObject({
      state: "measured",
      reportedBy: CASE_LAW_TOTAL_REPORTER.OPERATOR,
    });
  });
});

describe("country completeness", () => {
  const at = (iso: string) => new Date(iso).toISOString();
  const measured = (
    stored: number,
    reported: number,
    storedAsOf = at("2026-09-19T12:00:00.000Z"),
  ) =>
    ({
      state: "measured",
      stored,
      storedAsOf,
      reported,
      reportedAsOf: NOW.toISOString(),
      reportedBy: CASE_LAW_TOTAL_REPORTER.PUBLISHER,
    }) satisfies CaseLawSourceCompleteness;

  test("only measured sources are summed and the rest are counted beside the sum", () => {
    expect(
      caseLawCountryCompleteness([
        measured(100, 120),
        measured(50, 50),
        { state: "not-measured-yet" },
        { state: "not-counted-yet" },
      ]),
    ).toEqual({
      measuredSources: 2,
      stored: 150,
      reported: 170,
      storedAsOf: at("2026-09-19T12:00:00.000Z"),
      staleSources: 0,
      notMeasuredSources: 1,
      notCountedSources: 1,
    });
  });

  test("the summed count is stamped with its oldest part, never its newest", () => {
    const { storedAsOf } = caseLawCountryCompleteness([
      measured(10, 10, at("2026-09-19T12:00:00.000Z")),
      measured(20, 20, at("2026-06-01T00:00:00.000Z")),
      measured(30, 30, at("2026-08-15T00:00:00.000Z")),
    ]);
    expect(storedAsOf).toBe(at("2026-06-01T00:00:00.000Z"));
  });

  test("a stale source is summed and counted as stale", () => {
    expect(
      caseLawCountryCompleteness([
        { ...measured(10, 10), state: "stale" },
        measured(5, 5),
      ]),
    ).toMatchObject({ measuredSources: 2, stored: 15, staleSources: 1 });
  });

  test("a country holding only unmeasured sources reports no ratio at all", () => {
    expect(
      caseLawCountryCompleteness([
        { state: "not-measured-yet" },
        { state: "not-counted-yet" },
      ]),
    ).toEqual({
      measuredSources: 0,
      stored: 0,
      reported: 0,
      storedAsOf: null,
      staleSources: 0,
      notMeasuredSources: 1,
      notCountedSources: 1,
    });
  });

  // The API states the counts and never a ratio: a publisher total that lags
  // the corpus leaves stored above reported, and capping that here would hide
  // the lag from every reader instead of only from the percentage.
  test("a stored count above the publisher total survives the roll-up unchanged", () => {
    const { reported, stored } = caseLawCountryCompleteness([
      measured(120, 100),
    ]);
    expect(stored).toBe(120);
    expect(reported).toBe(100);
  });
});
