import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@stll/case-law-ingestion-core/ingestion-constants";

import {
  CASE_LAW_COVERAGE_AVAILABILITY,
  caseLawSourcePlacement,
  loadCaseLawCoverage,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

test("coverage year bounds cannot read capped facet years", async () => {
  const earliestYear = 1980;
  const latestYear = 2026;
  const mostFrequentYears = Array.from(
    { length: LIMITS.caseLawFacetLimit },
    (_, index) => 2000 + index,
  );
  const allFacetYears = [earliestYear, ...mostFrequentYears, latestYear];
  const cappedFacetYears = allFacetYears
    .map((year) => ({ value: String(year), count: year < 2000 ? 1 : 2 }))
    .toSorted((left, right) => right.count - left.count)
    .slice(0, LIMITS.caseLawFacetLimit);

  expect(allFacetYears).toHaveLength(LIMITS.caseLawFacetLimit + 2);
  expect(cappedFacetYears.map(({ value }) => value)).not.toContain(
    String(earliestYear),
  );
  expect(cappedFacetYears.map(({ value }) => value)).not.toContain(
    String(latestYear),
  );

  const coverage = await loadCaseLawCoverage({
    excludedSourceIds: [],
    onPartialFailure: () => undefined,
    now: new Date("2026-10-22T00:00:00.000Z"),
    readSources: async () => [
      {
        id: createSafeId<"caseLawSource">(),
        adapterKey: ADAPTER_KEYS.CZ_NS,
        enabled: true,
        lastSyncAt: null,
        importSnapshotDate: null,
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
        storedTotal: null,
        storedTotalAsOf: null,
        decisionYearFrom: earliestYear,
        decisionYearTo: latestYear,
        pendingTextCount: 0,
        courts: [],
        publishedDecisions: 0,
      },
    ],
    readArrivals: async () => new Map(),
    readCensus: async () => new Map(),
    readYearCompleteness: async () => new Map(),
    readFacets: async (country) =>
      Result.ok({
        country: [{ value: country, count: allFacetYears.length }],
        court: [],
        year: cappedFacetYears,
      }),
    readCourts: async () => [],
  });

  expect(Result.isOk(coverage)).toBe(true);
  if (Result.isError(coverage)) {
    throw coverage.error;
  }
  expect(coverage.value.countries).toHaveLength(1);
  expect(coverage.value.countries.at(0)).toMatchObject({
    availability: CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE,
    decisionYearFrom: earliestYear,
    decisionYearTo: latestYear,
  });
});

test("an unread slice ledger leaves every source not reconciled, never failing the page", async () => {
  const coverage = await loadCaseLawCoverage({
    excludedSourceIds: [],
    onPartialFailure: () => undefined,
    now: new Date("2026-10-22T00:00:00.000Z"),
    readSources: async () => [
      {
        id: createSafeId<"caseLawSource">(),
        adapterKey: ADAPTER_KEYS.CZ_NS,
        enabled: true,
        lastSyncAt: null,
        importSnapshotDate: null,
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
        storedTotal: null,
        storedTotalAsOf: null,
        decisionYearFrom: 1993,
        decisionYearTo: 2026,
        pendingTextCount: 0,
        courts: [],
        publishedDecisions: 0,
      },
    ],
    readArrivals: async () => new Map(),
    readCensus: async () => new Map(),
    readYearCompleteness: async () => {
      throw new Error("The slice ledger read was cancelled");
    },
    readFacets: async (country) =>
      Result.ok({
        country: [{ value: country, count: 1 }],
        court: [],
        year: [],
      }),
    readCourts: async () => [],
  });

  if (Result.isError(coverage)) {
    throw coverage.error;
  }
  expect(coverage.value.countries.at(0)?.sources).toEqual([
    expect.objectContaining({
      knownGaps: {
        type: "not_reconciled",
        reason: "Slice completeness could not be read.",
      },
    }),
  ]);
});

test("a bulk import with no completed run is left off the page without a report", async () => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  try {
    const source = (adapterKey: string) => ({
      id: createSafeId<"caseLawSource">(),
      adapterKey,
      enabled: true,
      lastSyncAt: null,
      importSnapshotDate: null,
      reportedTotal: null,
      reportedTotalAsOf: null,
      reportedTotalOrigin: null,
      storedTotal: null,
      storedTotalAsOf: null,
      decisionYearFrom: 1993,
      decisionYearTo: 2026,
      pendingTextCount: 0,
      courts: [],
      publishedDecisions: 0,
    });
    const coverage = await loadCaseLawCoverage({
      excludedSourceIds: [],
      onPartialFailure: () => undefined,
      now: new Date("2026-10-22T00:00:00.000Z"),
      readSources: async () => [
        source(ADAPTER_KEYS.CZ_NS),
        source(IMPORT_SOURCE_KEYS.COURTLISTENER),
      ],
      readArrivals: async () => new Map(),
      readCensus: async () => new Map(),
      readYearCompleteness: async () => new Map(),
      readFacets: async (country) =>
        Result.ok({
          country: [{ value: country, count: 1 }],
          court: [],
          year: [],
        }),
      readCourts: async () => [],
    });

    if (Result.isError(coverage)) {
      throw coverage.error;
    }
    expect(coverage.value.countries.map(({ country }) => country)).toEqual([
      "CZE",
    ]);
    expect(analytics.exceptions()).toHaveLength(0);
  } finally {
    logs.restore();
    analytics.restore();
  }
});

test("a bulk import with a recorded snapshot is placed with that snapshot as its edition", async () => {
  const coverage = await loadCaseLawCoverage({
    excludedSourceIds: [],
    onPartialFailure: () => undefined,
    now: new Date("2026-11-17T00:00:00.000Z"),
    readSources: async () => [
      {
        id: createSafeId<"caseLawSource">(),
        adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
        enabled: true,
        lastSyncAt: null,
        importSnapshotDate: "2026-10-31",
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
        storedTotal: null,
        storedTotalAsOf: null,
        decisionYearFrom: 1754,
        decisionYearTo: 2026,
        pendingTextCount: 0,
        courts: [],
        publishedDecisions: 0,
      },
    ],
    readArrivals: async () => new Map(),
    readCensus: async () => new Map(),
    readYearCompleteness: async () => new Map(),
    readFacets: async (country) =>
      Result.ok({
        country: [{ value: country, count: 1 }],
        court: [],
        year: [],
      }),
    readCourts: async () => [],
  });

  if (Result.isError(coverage)) {
    throw coverage.error;
  }
  const [usa] = coverage.value.countries;
  expect(usa?.country).toBe("USA");
  expect(usa?.sources).toEqual([
    expect.objectContaining({
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      edition: { type: "snapshot", snapshotDate: "2026-10-31" },
      health: "snapshot",
    }),
  ]);
});

test("placement states each kind of source row the same way on every page", () => {
  expect(
    caseLawSourcePlacement({
      adapterKey: ADAPTER_KEYS.CZ_NS,
      importSnapshotDate: null,
    }),
  ).toMatchObject({
    type: "placed",
    country: "CZE",
    edition: { type: "live" },
  });
  expect(
    caseLawSourcePlacement({
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      importSnapshotDate: null,
    }),
  ).toEqual({ type: "import-pending" });
  expect(
    caseLawSourcePlacement({
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      importSnapshotDate: "2026-10-31",
    }),
  ).toMatchObject({
    type: "placed",
    country: "USA",
    edition: { type: "snapshot", snapshotDate: "2026-10-31" },
  });
  expect(
    caseLawSourcePlacement({
      adapterKey: "cz-ostrava",
      importSnapshotDate: null,
    }),
  ).toEqual({ type: "unregistered" });
});
