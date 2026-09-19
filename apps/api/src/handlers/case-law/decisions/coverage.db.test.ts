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
import { readCaseLawArrivalsQuery } from "@/api/handlers/case-law/decisions/coverage-arrivals";
import { CASE_LAW_COVERAGE_HEALTH } from "@/api/handlers/case-law/decisions/coverage-health";
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
const disabledSourceId = createSafeId<"caseLawSource">();
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
        storedTotal: 4,
        storedTotalAsOf: new Date(NOW.getTime() - 2 * HOUR_IN_MS),
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
        storedTotal: 1,
        // Older than the Czech source's count: the country sums state their
        // oldest part, and this is what proves it.
        storedTotalAsOf: new Date(NOW.getTime() - 40 * HOUR_IN_MS),
      }),
      caseLawSourceRow({
        id: disabledSourceId,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        name: "cz disabled",
        enabled: false,
        lastSyncAt: null,
      }),
      caseLawSourceRow({
        id: withheldSourceId,
        adapterKey: ADAPTER_KEYS.CZ_US,
        name: "cz withheld",
        enabled: true,
        lastSyncAt: NOW,
        descriptor: {
          license: "restricted",
          attribution: "Publisher",
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
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
    readArrivals: async (sourceIds) =>
      await readAsReader(
        async (tx) =>
          await readCaseLawArrivalsQuery(tx, { sourceIds, now: NOW }),
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
    // The stored figure is read as a column, never counted here.
    expect(
      sources.find(({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS)
        ?.storedTotal,
    ).toBe(4);

    const arrivals = await readAsReader(
      async (tx) =>
        await readCaseLawArrivalsQuery(tx, {
          sourceIds: sources.map(({ id }) => id),
          now: NOW,
        }),
    );
    expect(arrivals.size).toBe(3);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the week's arrivals exclude a listing-only row",
  async () => {
    const arrivals = await readAsReader(
      async (tx) =>
        await readCaseLawArrivalsQuery(tx, {
          sourceIds: [czSourceId],
          now: NOW,
        }),
    );

    // Four rows are stored for this source: two recent, one old, one listed
    // but never served. Only the two recent published ones arrived this week.
    expect(arrivals.get(String(czSourceId))?.addedLastWeek).toBe(2);
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
    // The persisted count of the admitted Czech source; the withheld source's
    // feed is not listed at all and contributes nothing.
    expect(cze?.stored.decisions).toBe(4);
    expect(cze?.sources.map(({ adapterKey }) => adapterKey).toSorted()).toEqual(
      [ADAPTER_KEYS.CZ_NS, ADAPTER_KEYS.CZ_NSS],
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a source whose adapter is no longer registered is left out, not misfiled",
  async () => {
    const coverage = await loadCoverage({
      readSources: async () => {
        const sources = await readAsReader(readCaseLawCoverageSourcesQuery);
        // A retired adapter leaves its row behind; the column is a varchar
        // and the registry is deployment state, so the two legitimately
        // disagree. Without a manifest there is no country to file it under.
        for (const source of sources) {
          if (source.adapterKey === ADAPTER_KEYS.SK_COURTS) {
            source.adapterKey = "retired-adapter";
          }
        }
        return sources;
      },
    });
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }

    // Slovakia had exactly that one source, so the country disappears rather
    // than reporting an empty corpus, and nothing of it lands on a neighbour.
    expect(
      coverage.value.countries.map(({ country }) => country),
    ).not.toContain("SVK");
    expect(coverage.value.totals.stored.decisions).toBe(4);
    for (const entry of coverage.value.countries) {
      expect(entry.sources.map(({ adapterKey }) => adapterKey)).not.toContain(
        "retired-adapter",
      );
    }
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
    // The country's count is stamped with its oldest source count.
    expect(cze?.stored.asOf).toBe(
      new Date(NOW.getTime() - 2 * HOUR_IN_MS).toISOString(),
    );
    expect(cze).toMatchObject({ decisionYearFrom: 2019, decisionYearTo: 2026 });

    const svk = byCountry.get("SVK");
    expect(svk?.availability).toBe(
      CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION,
    );
    expect(svk).toMatchObject({ stored: { decisions: 1 } });
    expect(svk && "searchable" in svk).toBe(false);

    // The two populations are reported apart and never summed, and the total
    // count states the oldest of the counts behind it.
    expect(coverage.value.totals).toEqual({
      searchable: 3,
      stored: {
        decisions: 5,
        asOf: new Date(NOW.getTime() - 40 * HOUR_IN_MS).toISOString(),
      },
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
    // One current feed and one disabled feed: the country reads current, and
    // the disabled feed is still visible in its own row.
    expect(cze?.health).toBe(CASE_LAW_COVERAGE_HEALTH.CURRENT);
    const czeSources = new Map(
      (cze?.sources ?? []).map((source) => [source.adapterKey, source]),
    );
    expect(czeSources.get(ADAPTER_KEYS.CZ_NS)?.health).toBe(
      CASE_LAW_COVERAGE_HEALTH.CURRENT,
    );
    expect(czeSources.get(ADAPTER_KEYS.CZ_NSS)?.health).toBe(
      CASE_LAW_COVERAGE_HEALTH.DISABLED,
    );
    // The disabled feed has never had a total recorded, and says so rather
    // than being folded into the country's ratio.
    expect(czeSources.get(ADAPTER_KEYS.CZ_NSS)?.completeness).toEqual({
      state: "not-measured-yet",
    });
    expect(cze?.completeness).toMatchObject({
      measuredSources: 1,
      stored: 4,
      reported: 10,
      notMeasuredSources: 1,
      notCountedSources: 0,
    });

    const svk = byCountry.get("SVK");
    expect(svk?.health).toBe(CASE_LAW_COVERAGE_HEALTH.STALLED);
    expect(svk?.sources.at(0)?.completeness).toMatchObject({
      state: "measured",
      reportedBy: "operator",
      reported: 4,
      stored: 1,
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
  "a source the ingestion side has never counted says so rather than reporting zero",
  async () => {
    const coverage = await loadCoverage({
      readSources: async () => {
        const sources = await readAsReader(readCaseLawCoverageSourcesQuery);
        // As a source looks before its first sync cycle stamps a count.
        for (const source of sources) {
          if (source.adapterKey === ADAPTER_KEYS.CZ_NS) {
            source.storedTotal = null;
            source.storedTotalAsOf = null;
          }
        }
        return sources;
      },
    });
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
    ).toEqual({ state: "not-counted-yet" });
    // Its rows are not summed as zero; the country reports nothing counted.
    expect(cze?.stored).toEqual({ decisions: 0, asOf: null });
    expect(cze?.completeness).toMatchObject({
      measuredSources: 0,
      notCountedSources: 1,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the arrivals read bounds its own statement and hands the budget back",
  async () => {
    const budget = await readAsReader(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', '30s', true)`,
      );
      await readCaseLawArrivalsQuery(tx, {
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
    // The page is one source read plus one week-of-arrivals read plus, per
    // admitted country, the index's facets and one court-activity read. None
    // of them grows with the corpus, which is what keeps a corpus of millions
    // off a two-connection pool.
    let sourceReads = 0;
    let arrivalsReads = 0;
    const coverage = await loadCoverage({
      readSources: async () => {
        sourceReads += 1;
        return await readAsReader(readCaseLawCoverageSourcesQuery);
      },
      readArrivals: async (sourceIds) => {
        arrivalsReads += 1;
        return await readAsReader(
          async (tx) =>
            await readCaseLawArrivalsQuery(tx, { sourceIds, now: NOW }),
        );
      },
    });

    expect(Result.isOk(coverage)).toBe(true);
    expect(sourceReads).toBe(1);
    expect(arrivalsReads).toBe(1);
  },
  DB_TEST_TIMEOUT_MS,
);
