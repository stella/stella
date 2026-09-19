import type { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  CASE_LAW_COVERAGE_AVAILABILITY,
  loadCaseLawCoverage,
  readCaseLawCoverageSourcesQuery,
} from "@/api/handlers/case-law/decisions/coverage";
import { CASE_LAW_COVERAGE_HEALTH } from "@/api/handlers/case-law/decisions/coverage-health";
import { readCaseLawSourceCountsQuery } from "@/api/handlers/case-law/decisions/coverage-stored-counts";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

/** Drivers disagree: bun-sql returns the rows, pglite wraps them in `{ rows }`. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const NOW = new Date("2026-09-19T12:00:00.000Z");
const HOUR_IN_MS = 60 * 60 * 1000;

/** CZE is the admitted country; SVK is ingested and not admitted. */
const czSourceId = createSafeId<"caseLawSource">();
const skSourceId = createSafeId<"caseLawSource">();
const pausedSourceId = createSafeId<"caseLawSource">();
const withheldSourceId = createSafeId<"caseLawSource">();

const LISTING_ONLY = {
  _stellaPartialObservation: { isListingOnly: true },
} as const;

let client: PGlite;
let readAsReader: <T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
) => Promise<T>;

const decisionRow = (overrides: {
  caseNumber: string;
  country: string;
  court: string;
  sourceId: SafeId<"caseLawSource">;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}) => ({
  caseNumber: overrides.caseNumber,
  country: overrides.country,
  court: overrides.court,
  language: "cs",
  sourceId: overrides.sourceId,
  createdAt: overrides.createdAt,
  updatedAt: overrides.createdAt,
  metadata: overrides.metadata ?? {},
});

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    readAsReader = async (fn) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });

    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        id: czSourceId,
        adapterKey: ADAPTER_KEYS.CZ_NS,
        name: "cz",
        enabled: true,
        lastSyncAt: new Date(NOW.getTime() - HOUR_IN_MS),
        reportedTotal: 10,
        reportedTotalAsOf: new Date(NOW.getTime() - HOUR_IN_MS),
        reportedTotalOrigin: "adapter-poll",
      }),
      caseLawSourceRow({
        id: skSourceId,
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        name: "sk",
        enabled: true,
        // Older than the delayed window: this source reads as stalled.
        lastSyncAt: new Date(NOW.getTime() - 30 * 24 * HOUR_IN_MS),
        reportedTotal: 4,
        reportedTotalAsOf: new Date(NOW.getTime() - HOUR_IN_MS),
        reportedTotalOrigin: "operator",
      }),
      caseLawSourceRow({
        id: pausedSourceId,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        name: "cz paused",
        enabled: false,
        lastSyncAt: null,
      }),
      caseLawSourceRow({
        id: withheldSourceId,
        adapterKey: ADAPTER_KEYS.CZ_US,
        name: "cz withheld",
        enabled: true,
        lastSyncAt: NOW,
        descriptor: { allowsRedistribution: false },
      }),
    ]);

    await db.insert(caseLawDecisions).values([
      // Two published CZE rows inside the week, one older, one listing-only.
      decisionRow({
        caseNumber: "cz recent a",
        country: "CZE",
        court: "Nejvyšší soud",
        sourceId: czSourceId,
        createdAt: new Date(NOW.getTime() - HOUR_IN_MS),
      }),
      decisionRow({
        caseNumber: "cz recent b",
        country: "CZE",
        court: "Nejvyšší soud",
        sourceId: czSourceId,
        createdAt: new Date(NOW.getTime() - 2 * HOUR_IN_MS),
      }),
      decisionRow({
        caseNumber: "cz old",
        country: "CZE",
        court: "Nejvyšší soud",
        sourceId: czSourceId,
        createdAt: new Date(NOW.getTime() - 60 * 24 * HOUR_IN_MS),
      }),
      decisionRow({
        caseNumber: "cz listed only",
        country: "CZE",
        court: "Nejvyšší soud",
        sourceId: czSourceId,
        createdAt: new Date(NOW.getTime() - HOUR_IN_MS),
        metadata: LISTING_ONLY,
      }),
      // One Slovak row, and one withheld Czech row that must reach nothing.
      decisionRow({
        caseNumber: "sk one",
        country: "SVK",
        court: "Najvyšší súd",
        sourceId: skSourceId,
        createdAt: new Date(NOW.getTime() - HOUR_IN_MS),
      }),
      decisionRow({
        caseNumber: "cz withheld",
        country: "CZE",
        court: "Ústavní soud",
        sourceId: withheldSourceId,
        createdAt: new Date(NOW.getTime() - HOUR_IN_MS),
      }),
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const loadCoverage = async (
  overrides: Partial<Parameters<typeof loadCaseLawCoverage>[0]> = {},
) =>
  await loadCaseLawCoverage({
    excludedSourceIds: [],
    now: NOW,
    readSources: async () =>
      await readAsReader(readCaseLawCoverageSourcesQuery),
    readCounts: async (sourceIds) =>
      await readAsReader(
        async (tx) =>
          await readCaseLawSourceCountsQuery(tx, { sourceIds, now: NOW }),
      ),
    readFacets: async (country) =>
      Result.ok({
        country: [{ value: country, count: 3 }],
        court: [{ value: "Nejvyšší soud", count: 3 }],
        year: [
          { value: "2019", count: 1 },
          { value: "2026", count: 2 },
        ],
      }),
    readCourts: async () => [],
    ...overrides,
  });

test(
  "the reader role can run every statement the coverage page needs",
  async () => {
    const sources = await readAsReader(readCaseLawCoverageSourcesQuery);
    // The withheld source is filtered in SQL, so it never reaches the loader.
    expect(sources.map(({ adapterKey }) => adapterKey).toSorted()).toEqual([
      ADAPTER_KEYS.CZ_NS,
      ADAPTER_KEYS.CZ_NSS,
      ADAPTER_KEYS.SK_COURTS,
    ]);

    const counts = await readAsReader(
      async (tx) =>
        await readCaseLawSourceCountsQuery(tx, {
          sourceIds: sources.map(({ id }) => id),
          now: NOW,
        }),
    );
    expect(counts.size).toBe(3);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "stored counts hold listing-only rows and the week's arrivals do not",
  async () => {
    const counts = await readAsReader(
      async (tx) =>
        await readCaseLawSourceCountsQuery(tx, {
          sourceIds: [czSourceId],
          now: NOW,
        }),
    );
    const cz = counts.get(String(czSourceId));

    // Four rows stored: two recent, one old, one listed but never served.
    expect(cz?.stored).toBe(4);
    expect(cz?.capped).toBe(false);
    // Two arrived this week and are public; the listing-only row is not.
    expect(cz?.addedLastWeek).toBe(2);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a withheld source's decisions are counted into nothing",
  async () => {
    const coverage = await loadCoverage();
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const cze = coverage.value.countries.find(
      ({ country }) => country === "CZE",
    );
    // Only the four rows of the admitted Czech source; the withheld source's
    // row is absent and its feed is not listed at all.
    expect(cze?.stored.decisions).toBe(4);
    expect(cze?.sources.map(({ adapterKey }) => adapterKey).toSorted()).toEqual(
      [ADAPTER_KEYS.CZ_NS, ADAPTER_KEYS.CZ_NSS],
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "an admitted country is searchable and an ingested one is in preparation",
  async () => {
    const coverage = await loadCoverage();
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const byCountry = new Map(
      coverage.value.countries.map((entry) => [entry.country, entry]),
    );

    const cze = byCountry.get("CZE");
    expect(cze?.availability).toBe(CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE);
    // The searchable number is the index's, not a count of the table.
    expect(cze).toMatchObject({ searchable: 3, stored: { decisions: 4 } });
    expect(cze).toMatchObject({ decisionYearFrom: 2019, decisionYearTo: 2026 });

    const svk = byCountry.get("SVK");
    expect(svk?.availability).toBe(
      CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION,
    );
    expect(svk).toMatchObject({ stored: { decisions: 1 } });
    expect(svk && "searchable" in svk).toBe(false);

    // The two populations are reported apart and never summed.
    expect(coverage.value.totals).toEqual({
      searchable: 3,
      stored: { precision: "exact", decisions: 5 },
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "health and completeness come back per source and rolled up per country",
  async () => {
    const coverage = await loadCoverage();
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const byCountry = new Map(
      coverage.value.countries.map((entry) => [entry.country, entry]),
    );

    const cze = byCountry.get("CZE");
    // One current feed and one paused feed: the country reads current, and
    // the paused feed is still visible in its own row.
    expect(cze?.health).toBe(CASE_LAW_COVERAGE_HEALTH.CURRENT);
    const czeSources = new Map(
      (cze?.sources ?? []).map((source) => [source.adapterKey, source]),
    );
    expect(czeSources.get(ADAPTER_KEYS.CZ_NS)?.health).toBe(
      CASE_LAW_COVERAGE_HEALTH.CURRENT,
    );
    expect(czeSources.get(ADAPTER_KEYS.CZ_NSS)?.health).toBe(
      CASE_LAW_COVERAGE_HEALTH.PAUSED,
    );
    // The paused feed has never had a total recorded, and says so rather
    // than being folded into the country's ratio.
    expect(czeSources.get(ADAPTER_KEYS.CZ_NSS)?.completeness).toEqual({
      state: "not-measured-yet",
    });
    expect(cze?.completeness).toMatchObject({
      measuredSources: 1,
      stored: 4,
      reported: 10,
      unmeasuredSources: 1,
    });

    const svk = byCountry.get("SVK");
    expect(svk?.health).toBe(CASE_LAW_COVERAGE_HEALTH.STALLED);
    expect(svk?.sources.at(0)?.completeness).toMatchObject({
      state: "measured",
      reportedBy: "operator",
      reported: 4,
      stored: { precision: "exact", decisions: 1 },
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "an admitted country whose index cannot be read falls back to what is stored",
  async () => {
    const coverage = await loadCoverage({
      readFacets: async () => Result.err({ message: "index unavailable" }),
    });
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const cze = coverage.value.countries.find(
      ({ country }) => country === "CZE",
    );
    // Not zero searchable decisions: no searchable number at all.
    expect(cze?.availability).toBe(
      CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION,
    );
    expect(cze?.stored.decisions).toBe(4);
    expect(coverage.value.totals.searchable).toBe(0);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a source whose count did not finish is uncounted, never zero",
  async () => {
    const coverage = await loadCoverage({ readCounts: async () => null });
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const cze = coverage.value.countries.find(
      ({ country }) => country === "CZE",
    );
    expect(
      cze?.sources.find(({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS)
        ?.completeness,
    ).toMatchObject({ state: "count-unavailable", reported: 10 });
    expect(cze?.completeness).toMatchObject({
      measuredSources: 0,
      uncountedSources: 1,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the counts read bounds its own statement and hands the budget back",
  async () => {
    const budget = await readAsReader(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', '30s', true)`,
      );
      await readCaseLawSourceCountsQuery(tx, {
        sourceIds: [czSourceId],
        now: NOW,
      });
      const result: unknown = await tx.execute(
        sql`SELECT current_setting('statement_timeout') AS statement_timeout`,
      );
      const rows: unknown =
        Array.isArray(result) || !isRecord(result) ? result : result["rows"];
      const row: unknown = Array.isArray(rows) ? rows.at(0) : undefined;
      return isRecord(row) ? row["statement_timeout"] : null;
    });

    expect(budget).toBe("30s");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the whole read costs a fixed number of statements however many sources exist",
  async () => {
    // The page is one source read plus one counts read plus, per admitted
    // country, the index's facets and one court-activity read. Nothing here
    // grows with the number of sources, which is what keeps a corpus of
    // millions off a two-connection pool.
    let sourceReads = 0;
    let countReads = 0;
    const coverage = await loadCoverage({
      readSources: async () => {
        sourceReads += 1;
        return await readAsReader(readCaseLawCoverageSourcesQuery);
      },
      readCounts: async (sourceIds) => {
        countReads += 1;
        return await readAsReader(
          async (tx) =>
            await readCaseLawSourceCountsQuery(tx, { sourceIds, now: NOW }),
        );
      },
    });

    expect(Result.isOk(coverage)).toBe(true);
    expect(sourceReads).toBe(1);
    expect(countReads).toBe(1);
  },
  DB_TEST_TIMEOUT_MS,
);
