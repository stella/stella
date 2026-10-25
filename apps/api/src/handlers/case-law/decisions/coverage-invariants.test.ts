import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  CASE_LAW_COVERAGE_AVAILABILITY,
  loadCaseLawCoverage,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { LIMITS } from "@/api/lib/limits";

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
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
        storedTotal: null,
        storedTotalAsOf: null,
        decisionYearFrom: earliestYear,
        decisionYearTo: latestYear,
        pendingTextCount: 0,
      },
    ],
    readArrivals: async () => new Map(),
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
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
        storedTotal: null,
        storedTotalAsOf: null,
        decisionYearFrom: 1993,
        decisionYearTo: 2026,
        pendingTextCount: 0,
      },
    ],
    readArrivals: async () => new Map(),
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
