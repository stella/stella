import type { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { PROVISION_LINK_CAPABILITIES } from "@stll/api-contract/provision-link-capability";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  caseLawCoverageSlices,
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSourceArrivals,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  CASE_LAW_COVERAGE_AVAILABILITY,
  loadCaseLawCoverage,
  readCaseLawCoverageSourcesQuery,
} from "@/api/handlers/case-law/decisions/coverage";
import { readCaseLawArrivalsQuery } from "@/api/handlers/case-law/decisions/coverage-arrivals";
import { CASE_LAW_COVERAGE_HEALTH } from "@/api/handlers/case-law/decisions/coverage-health";
import {
  readCaseLawCoverageYearsQuery,
  summarizeCaseLawCoverageYears,
} from "@/api/handlers/case-law/decisions/coverage-years";
import {
  caseLawCourtStatusRows,
  readCaseLawCourtCountQuery,
} from "@/api/handlers/case-law/decisions/status-courts";
import { PL_NSA_SNAPSHOT } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readProvisionPendingCounts } from "@/api/lib/case-law/provision-pending";
import { readPendingTextCountsBySource } from "@/api/lib/case-law/public-subject";
import {
  publishedCaseLawDecisionFor,
  publishedCaseLawDecisionSqlFor,
} from "@/api/lib/case-law/published-decisions-sql";
import { refreshCaseLawSourceArrivals } from "@/api/lib/case-law/source-arrivals-refresh";
import { SOURCE_ARRIVALS_FRESHNESS_MS } from "@/api/lib/case-law/source-arrivals-window";
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

/** CZE is the admitted country; AUT is ingested and not admitted. */
const czSourceId = createSafeId<"caseLawSource">();
const atSourceId = createSafeId<"caseLawSource">();
const disabledSourceId = createSafeId<"caseLawSource">();
const withheldSourceId = createSafeId<"caseLawSource">();

const COVERAGE_YEARS = [
  1981, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012,
  2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2026,
] as const;

const LISTING_ONLY = {
  _stellaPartialObservation: { isListingOnly: true },
} as const;

let client: PGlite;
let refreshDb: Parameters<typeof refreshCaseLawSourceArrivals>[0];
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
  decisionDate?: string;
  fulltext?: string;
  redactedAt?: Date;
}) => ({
  caseNumber: overrides.caseNumber,
  country: overrides.country,
  court: overrides.court,
  language: "cs",
  sourceId: overrides.sourceId,
  createdAt: overrides.createdAt,
  updatedAt: overrides.createdAt,
  metadata: overrides.metadata ?? {},
  decisionDate: overrides.decisionDate,
  fulltext: overrides.fulltext,
  redactedAt: overrides.redactedAt,
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
        id: atSourceId,
        adapterKey: ADAPTER_KEYS.AT_COURTS,
        name: "at",
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
      // One Austrian row, and one withheld Czech row that must reach nothing.
      decisionRow({
        caseNumber: "at one",
        country: "AUT",
        court: "Oberster Gerichtshof",
        sourceId: atSourceId,
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

    // More than a facet page of distinct years, with sparse endpoints, proves
    // coverage reads exact source bounds rather than capped year buckets.
    await db.insert(caseLawDecisions).values(
      COVERAGE_YEARS.map((year) =>
        decisionRow({
          caseNumber: `cz coverage year ${year}`,
          country: "CZE",
          court: "Nejvyšší soud",
          sourceId: czSourceId,
          createdAt: new Date("2000-01-01T00:00:00.000Z"),
          fulltext: "Published decision text",
          decisionDate: `${year}-06-15`,
        }),
      ),
    );

    const dated = await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, czSourceId));
    await db.insert(caseLawSearchDocuments).values(
      dated.map(({ id }) => ({
        decisionId: id,
        language: "cs",
        regconfig: "simple",
        searchableText: "Published decision text",
        tsv: sql`to_tsvector('simple', 'Published decision text')`,
      })),
    );

    // SAFETY: the PGlite handle implements the root select and transaction
    // surface the scheduled refresh uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded test database stands in for the root pool
    refreshDb = db as unknown as typeof refreshDb;
    await refreshCaseLawSourceArrivals(refreshDb, { now: NOW });
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test(
  "court counts exclude withdrawn, listing-only and unserved courts",
  async () => {
    const db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: `court-count-${sourceId}`,
        name: "Court count fixture",
      }),
    );
    try {
      const rows = [
        { court: "Published court A", metadata: {}, redactedAt: undefined },
        { court: "Published court B", metadata: {}, redactedAt: undefined },
        { court: "Withdrawn court", metadata: {}, redactedAt: NOW },
        {
          court: "Listing-only court",
          metadata: LISTING_ONLY,
          redactedAt: undefined,
        },
        { court: "Unserved court", metadata: {}, redactedAt: undefined },
      ].map(({ court, metadata, redactedAt }) => ({
        ...decisionRow({
          caseNumber: court,
          country: "POL",
          court,
          sourceId,
          createdAt: NOW,
          metadata,
          ...(redactedAt === undefined ? {} : { redactedAt }),
        }),
        id: createSafeId<"caseLawDecision">(),
      }));
      await db.insert(caseLawDecisions).values(rows);
      await db.insert(caseLawSearchDocuments).values(
        rows.slice(0, 4).map(({ id }) => ({
          decisionId: id,
          language: "cs",
          regconfig: "simple",
          searchableText: "Published decision text",
          tsv: sql`to_tsvector('simple', 'Published decision text')`,
        })),
      );
      const courtCount = await readAsReader(
        async (tx) =>
          await readCaseLawCourtCountQuery(tx, {
            country: "POL",
            excludedSourceIds: [],
            engine: "pg-fts",
          }),
      );
      expect(courtCount).toBe(2);
      const breakdown = caseLawCourtStatusRows({
        country: "POL",
        buckets: [{ value: "Published court A", count: 1 }],
        activity: new Map(),
        courtWeights: courtWeightMapFromSeed(),
        total: 2,
        courtCount,
      });
      expect(breakdown.find(({ type }) => type === "other-courts")).toEqual({
        type: "other-courts",
        tier: "other",
        courts: 1,
        decisions: 1,
      });
      expect(
        await readAsReader(
          async (tx) =>
            await readCaseLawCourtCountQuery(tx, {
              country: "POL",
              excludedSourceIds: [],
              engine: "corpus-index",
            }),
        ),
      ).toBeNull();
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

const loadCoverage = async (
  overrides: Partial<Parameters<typeof loadCaseLawCoverage>[0]> = {},
) =>
  await loadCaseLawCoverage({
    excludedSourceIds: [],
    onPartialFailure: () => undefined,
    now: NOW,
    readSources: async () =>
      await readAsReader(readCaseLawCoverageSourcesQuery),
    readArrivals: async (sourceIds) =>
      await readAsReader(
        async (tx) =>
          await readCaseLawArrivalsQuery(tx, { sourceIds, now: NOW }),
      ),
    readYearCompleteness: async (sources) =>
      await readAsReader(
        async (tx) => await readCaseLawCoverageYearsQuery(tx, sources),
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
  "slice ledgers report complete, short, and unlisted years while unsliced sources are explicit",
  async () => {
    const db = drizzle({ client });
    await db.insert(caseLawCoverageSlices).values([
      {
        sourceId: czSourceId,
        slice: "2023-01-01",
        reported: 2,
        collected: 2,
        checkedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        sourceId: czSourceId,
        slice: "2024-01-01",
        reported: 5,
        collected: 3,
        checkedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        sourceId: czSourceId,
        slice: "2025-01-02",
        walkError: "publisher_unavailable",
        checkedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        sourceId: czSourceId,
        slice: "2025-01-03",
        walkError: "rate_limited",
        checkedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ]);

    try {
      const coverage = await loadCoverage();
      if (Result.isError(coverage)) {
        throw coverage.error;
      }
      const czech = coverage.value.countries
        .find(({ country }) => country === "CZE")
        ?.sources.find(({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS);
      expect(czech?.knownGaps).toEqual({
        type: "reconciled",
        summary: { missing: 2, shortSlices: 1, unlistedSlices: 2 },
        years: [
          { year: 2023, type: "complete" },
          {
            year: 2024,
            type: "gaps",
            missing: 2,
            shortSlices: 1,
          },
          {
            year: 2025,
            type: "unlisted",
            missing: 0,
            shortSlices: 0,
            unlistedSlices: 2,
          },
        ],
      });

      const unsliced = await readAsReader(
        async (tx) =>
          await readCaseLawCoverageYearsQuery(tx, [
            { id: czSourceId, adapterKey: ADAPTER_KEYS.PL_NSA },
          ]),
      );
      expect(unsliced.get(String(czSourceId))).toEqual({
        type: "not_reconciled",
        reason:
          "The source listing is not partitioned into calendar-date slices.",
      });
    } finally {
      await db
        .delete(caseLawCoverageSlices)
        .where(eq(caseLawCoverageSlices.sourceId, czSourceId));
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a walk error never reaches the public coverage response",
  async () => {
    const db = drizzle({ client });
    const secret = "k3y-6348-walk";
    await db.insert(caseLawCoverageSlices).values({
      sourceId: czSourceId,
      slice: "2022-03-04",
      walkError: `AdapterFetchError: GET https://listing.example/rozhodnuti?key=${secret}&strana=2 refused`,
      checkedAt: new Date("2026-01-05T00:00:00.000Z"),
    });

    try {
      const coverage = await loadCoverage();
      if (Result.isError(coverage)) {
        throw coverage.error;
      }
      const czech = coverage.value.countries
        .find(({ country }) => country === "CZE")
        ?.sources.find(({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS);
      // The failed walk still counts as an unread listing period.
      expect(
        czech?.knownGaps.type === "reconciled"
          ? czech.knownGaps.years.find(({ year }) => year === 2022)
          : undefined,
      ).toEqual({
        year: 2022,
        type: "unlisted",
        missing: 0,
        shortSlices: 0,
        unlistedSlices: 1,
      });
      const body = JSON.stringify(coverage.value);
      for (const leaked of [
        secret,
        "key=",
        "listing.example",
        "AdapterFetchError",
      ]) {
        expect(body).not.toContain(leaked);
      }
      // The public role holds no grant on the column at all.
      // Drizzle wraps the driver error, so the refusal is on the cause.
      expect(
        await rejectionOf(
          readAsReader(
            async (tx) =>
              await tx.execute(
                sql`SELECT walk_error FROM case_law_coverage_slices LIMIT 1`,
              ),
          ),
        ),
      ).toMatchObject({
        cause: { message: expect.stringContaining("permission denied") },
      });
    } finally {
      await db
        .delete(caseLawCoverageSlices)
        .where(eq(caseLawCoverageSlices.sourceId, czSourceId));
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test("per-year missing counts sum to the source missing count", () => {
  assertProperty(
    "per-year missing counts sum to the source missing count",
    fc.property(
      fc.array(
        fc.record({
          year: fc.integer({ min: 1900, max: 2100 }),
          missing: fc.nat({ max: 10_000 }),
          shortSlices: fc.nat({ max: 366 }),
          unlistedSlices: fc.nat({ max: 366 }),
        }),
      ),
      (rows) => {
        const result = summarizeCaseLawCoverageYears(rows);
        let missingFromYears = 0;
        for (const year of result.years) {
          if (year.type === "gaps") {
            missingFromYears += year.missing;
          }
          if (year.type === "unlisted") {
            missingFromYears += year.missing;
          }
        }
        expect(missingFromYears).toBe(result.summary.missing);
      },
    ),
    { numRuns: 100 },
  );
});

test(
  "year bounds span every held decision, indexed or not",
  async () => {
    const db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: `coverage-regression-${sourceId}`,
        name: "Coverage regression fixture",
      }),
    );
    try {
      const inserted = await db
        .insert(caseLawDecisions)
        .values([
          ...[2000, 2010].map((year) =>
            decisionRow({
              caseNumber: `published ${year}`,
              country: "CZE",
              court: "Nejvyšší soud",
              sourceId,
              createdAt: new Date("2000-01-01T00:00:00.000Z"),
              decisionDate: `${year}-06-15`,
              fulltext: "Published decision text",
            }),
          ),
          ...["withdrawn", "listing-only"].flatMap((status) =>
            [1900, 2020].map((year) =>
              decisionRow({
                caseNumber: `excluded ${status} ${year}`,
                country: "CZE",
                court: "Nejvyšší soud",
                sourceId,
                createdAt: new Date("2000-01-01T00:00:00.000Z"),
                decisionDate: `${year}-06-15`,
                ...(status === "listing-only"
                  ? {
                      fulltext: "Excluded decision text",
                      metadata: LISTING_ONLY,
                    }
                  : { redactedAt: NOW }),
              }),
            ),
          ),
        ])
        .returning({
          id: caseLawDecisions.id,
          caseNumber: caseLawDecisions.caseNumber,
        });
      const expectedIds = inserted
        .filter(({ caseNumber }) => caseNumber.startsWith("published "))
        .map(({ id }) => id)
        .toSorted();
      expect(expectedIds).toHaveLength(2);
      await db.insert(caseLawSearchDocuments).values(
        expectedIds.map((id) => ({
          decisionId: id,
          language: "cs",
          regconfig: "simple",
          searchableText: "Published decision text",
          tsv: sql`to_tsvector('simple', 'Published decision text')`,
        })),
      );
      const decision = alias(caseLawDecisions, "publication_parity_decisions");
      {
        const published = await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              publishedCaseLawDecisionFor(caseLawDecisions),
            ),
          );
        const aliased = await db
          .select({ id: decision.id })
          .from(decision)
          .where(
            and(
              eq(decision.sourceId, sourceId),
              publishedCaseLawDecisionFor(decision),
            ),
          );
        const raw = await db
          .select({ id: decision.id })
          .from(decision)
          .where(
            and(
              eq(decision.sourceId, sourceId),
              sql.raw(
                publishedCaseLawDecisionSqlFor("publication_parity_decisions"),
              ),
            ),
          );
        for (const rows of [published, aliased, raw]) {
          expect(rows.map(({ id }) => id).toSorted()).toEqual(expectedIds);
        }
      }
      await readAsReader(async (tx) => {
        const published = await tx
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.sourceId, sourceId));
        expect(published.map(({ id }) => id).toSorted()).toEqual(expectedIds);
      });
      const fixture = await client.query(
        `
        SELECT extract(year FROM decision_date)::integer AS year, count(*)::integer AS count
        FROM case_law_decisions WHERE source_id = $1 AND case_number LIKE 'excluded %'
        GROUP BY decision_date ORDER BY decision_date
      `,
        [sourceId],
      );
      expect(fixture.rows).toEqual([
        { year: 1900, count: 2 },
        { year: 2020, count: 2 },
      ]);
      await db.insert(caseLawDecisions).values(
        [1800, 2020].map((year) =>
          decisionRow({
            caseNumber: `unindexed ${year}`,
            country: "CZE",
            court: "Nejvyšší soud",
            sourceId,
            createdAt: NOW,
            decisionDate: `${year}-06-15`,
            fulltext: "Published but unindexed text",
          }),
        ),
      );
      const sources = await readAsReader(async (tx) =>
        readCaseLawCoverageSourcesQuery(tx),
      );
      // Held, not searchable: the unindexed endpoints still bound the years,
      // while withdrawn and listing-only decisions never do.
      expect(sources.find(({ id }) => id === sourceId)).toMatchObject({
        decisionYearFrom: 1800,
        decisionYearTo: 2020,
        pendingTextCount: 0,
      });
      expect(sources.find(({ id }) => id === atSourceId)).toMatchObject({
        decisionYearFrom: null,
        decisionYearTo: null,
      });
      expect(sources.find(({ id }) => id === disabledSourceId)).toMatchObject({
        decisionYearFrom: null,
        decisionYearTo: null,
      });
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "pending-text aggregates count listing-only rows and exclude erased or completed rows",
  async () => {
    const db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: `pending-text-${sourceId}`,
        name: "Pending-text fixture",
      }),
    );
    try {
      await db.insert(caseLawDecisions).values(
        [
          { caseNumber: "pending a", metadata: LISTING_ONLY },
          { caseNumber: "pending b", metadata: LISTING_ONLY },
          { caseNumber: "erased", metadata: LISTING_ONLY, redactedAt: NOW },
          {
            caseNumber: "completed",
            metadata: LISTING_ONLY,
            fulltext: "Decision text",
          },
          { caseNumber: "detail", metadata: {} },
        ].map((row) =>
          decisionRow({
            ...row,
            country: "CZE",
            court: "Nejvyšší soud",
            sourceId,
            createdAt: NOW,
          }),
        ),
      );
      const counts = await readAsReader(
        async (tx) =>
          await readPendingTextCountsBySource(tx, [sourceId, withheldSourceId]),
      );
      expect(counts).toEqual([{ sourceId, pendingTextCount: 2 }]);
      expect(
        await readAsReader(
          async (tx) => await readPendingTextCountsBySource(tx, []),
        ),
      ).toEqual([]);
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the reader role can run every statement the coverage page needs",
  async () => {
    const sources = await readAsReader(readCaseLawCoverageSourcesQuery);
    // The withheld source is filtered in SQL, so it never reaches the loader.
    expect(sources.map(({ adapterKey }) => adapterKey).toSorted()).toEqual([
      ADAPTER_KEYS.AT_COURTS,
      ADAPTER_KEYS.CZ_NS,
      ADAPTER_KEYS.CZ_NSS,
    ]);
    const czech = sources.find(
      ({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS,
    );
    expect(czech?.decisionYearFrom).toBe(1981);
    expect(czech?.decisionYearTo).toBe(2026);
    expect(czech?.pendingTextCount).toBe(1);

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

    const pendingCounts = await readAsReader(readProvisionPendingCounts);
    expect(pendingCounts.map(({ country }) => country)).toEqual(
      CASE_LAW_JURISDICTIONS,
    );
    for (const { country, state } of pendingCounts) {
      const capability = PROVISION_LINK_CAPABILITIES[country];
      if (capability.type === "notSupportedYet") {
        expect(state).toEqual(capability);
        continue;
      }
      expect(state.type).toBe("unavailable");
      expect(state).not.toHaveProperty("pendingCount");
    }
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
          if (source.adapterKey === ADAPTER_KEYS.AT_COURTS) {
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

    // Austria had exactly that one source, so the country disappears rather
    // than reporting an empty corpus, and nothing of it lands on a neighbour.
    expect(
      coverage.value.countries.map(({ country }) => country),
    ).not.toContain("AUT");
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
    expect(cze).toMatchObject({ decisionYearFrom: 1981, decisionYearTo: 2026 });

    const aut = byCountry.get("AUT");
    expect(aut?.availability).toBe(
      CASE_LAW_COVERAGE_AVAILABILITY.IN_PREPARATION,
    );
    expect(aut).toMatchObject({ stored: { decisions: 1 } });
    expect(aut && "searchable" in aut).toBe(false);

    // The two populations are reported apart and never summed, and the total
    // count states the oldest of the counts behind it.
    expect(coverage.value.totals).toEqual({
      addedLastWeek: 2,
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

    const aut = byCountry.get("AUT");
    expect(aut?.health).toBe(CASE_LAW_COVERAGE_HEALTH.STALLED);
    expect(aut?.sources.at(0)?.completeness).toMatchObject({
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
    expect(coverage.value.totals).toMatchObject({
      searchable: null,
      addedLastWeek: null,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: exercise persisted coverage reads with an isolated source in the migrated database.
test.each([
  {
    name: "complete facet reads give exact searchable totals",
    unavailableCountries: [],
    expected: { searchable: 8, addedLastWeek: 9 },
  },
  {
    name: "partial facet reads leave searchable totals unknown",
    unavailableCountries: ["CZE"],
    expected: { searchable: null, addedLastWeek: null },
  },
  {
    name: "partial facet reads after a known country leave searchable totals unknown",
    unavailableCountries: ["EU"],
    expected: { searchable: null, addedLastWeek: null },
  },
  {
    name: "all facet reads failing leave searchable totals unknown",
    unavailableCountries: ["CZE", "EU"],
    expected: { searchable: null, addedLastWeek: null },
  },
])(
  "$name",
  async ({ unavailableCountries, expected }) => {
    const db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        storedTotal: 5,
        storedTotalAsOf: NOW,
      }),
    );
    try {
      await db
        .insert(caseLawSourceArrivals)
        .values({ sourceId, addedLastWeek: 7, countedAt: NOW });
      const failedParts: string[] = [];
      const coverage = await loadCoverage({
        onPartialFailure: (part) => {
          failedParts.push(part);
        },
        readFacets: async (country) =>
          unavailableCountries.some((candidate) => candidate === country)
            ? Result.err({ message: "Index unavailable" })
            : Result.ok({
                country: [{ value: country, count: country === "CZE" ? 3 : 5 }],
                court: [],
                year: [],
              }),
      });
      expect(Result.isOk(coverage)).toBe(true);
      if (Result.isError(coverage)) {
        return;
      }
      expect(coverage.value.countries.map(({ country }) => country)).toEqual([
        "AUT",
        "CZE",
        "EU",
      ]);
      expect(failedParts).toEqual(unavailableCountries.map(() => "facets"));
      expect(coverage.value.totals).toMatchObject(expected);
      expect(coverage.value.totals.stored.decisions).toBe(10);
    } finally {
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a week the arrivals read did not answer for is unknown, never zero",
  async () => {
    const coverage = await loadCoverage({ readArrivals: async () => null });
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const cze = coverage.value.countries.find(
      ({ country }) => country === "CZE",
    );
    // A zero here would claim a quiet week the corpus never observed; the
    // sum over the country is as unknown as its sources.
    expect(cze?.sources.map(({ addedLastWeek }) => addedLastWeek)).toEqual([
      null,
      null,
    ]);
    expect(cze?.addedLastWeek).toBeNull();
    expect(coverage.value.totals.addedLastWeek).toBeNull();
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a court breakdown that cannot be read is unknown, not an empty list",
  async () => {
    const coverage = await loadCoverage({
      readCourts: async () => {
        throw new Error("activity read timed out");
      },
    });
    expect(Result.isOk(coverage)).toBe(true);
    if (Result.isError(coverage)) {
      return;
    }
    const cze = coverage.value.countries.find(
      ({ country }) => country === "CZE",
    );
    // An empty list would say the index names no court, which is a
    // different fact from the read having failed.
    expect(cze?.availability).toBe(CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE);
    expect(cze && "courts" in cze ? cze.courts : undefined).toBeNull();
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

/** Rows of the snapshot as the owner sees them, policy aside. */
const ownerArrivalRows = async () => {
  const result: unknown = await drizzle({ client }).execute(
    sql`SELECT source_id, added_last_week FROM case_law_source_arrivals ORDER BY source_id`,
  );
  const rows: unknown =
    Array.isArray(result) || !isRecord(result) ? result : result["rows"];
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
};

test(
  "a stored count older than the freshness window reads as unknown, not as this week",
  async () => {
    const readAt = async (now: Date) =>
      await readAsReader(
        async (tx) =>
          await readCaseLawArrivalsQuery(tx, { sourceIds: [czSourceId], now }),
      );

    const atEdge = await readAt(
      new Date(NOW.getTime() + SOURCE_ARRIVALS_FRESHNESS_MS),
    );
    expect(atEdge.get(String(czSourceId))?.addedLastWeek).toBe(2);

    const pastEdge = await readAt(
      new Date(NOW.getTime() + SOURCE_ARRIVALS_FRESHNESS_MS + 1),
    );
    expect(pastEdge.has(String(czSourceId))).toBe(false);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a withheld source is counted by the refresh but never readable by the public role",
  async () => {
    // The owner refresh counts every source, so a policy change needs no
    // recount: the reader's row policy decides what is published.
    expect(
      (await ownerArrivalRows()).find(
        (row) => row["source_id"] === String(withheldSourceId),
      )?.["added_last_week"],
    ).toBe(1);

    const arrivals = await readAsReader(
      async (tx) =>
        await readCaseLawArrivalsQuery(tx, {
          sourceIds: [withheldSourceId],
          now: NOW,
        }),
    );
    expect(arrivals.size).toBe(0);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a stored week ends at its own count: a later arrival is not in it",
  async () => {
    // Counted ninety minutes before NOW: the row two hours old is in the
    // week, the row one hour old arrived after the count and is not.
    const earlier = new Date(NOW.getTime() - 90 * 60_000);
    try {
      await refreshCaseLawSourceArrivals(refreshDb, { now: earlier });
      const arrivals = await readAsReader(
        async (tx) =>
          await readCaseLawArrivalsQuery(tx, {
            sourceIds: [czSourceId],
            now: earlier,
          }),
      );
      expect(arrivals.get(String(czSourceId))?.addedLastWeek).toBe(1);
    } finally {
      await refreshCaseLawSourceArrivals(refreshDb, { now: NOW });
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a refresh replaces the whole snapshot and recounts the window from its own instant",
  async () => {
    // Ninety minutes before the week ends, only the row an hour old is
    // still inside it; the row two hours old has left the window.
    const later = new Date(NOW.getTime() + 7 * 24 * HOUR_IN_MS - 90 * 60_000);
    try {
      await refreshCaseLawSourceArrivals(refreshDb, { now: later });
      const rows = await ownerArrivalRows();
      expect(rows).toHaveLength(4);
      const arrivals = await readAsReader(
        async (tx) =>
          await readCaseLawArrivalsQuery(tx, {
            sourceIds: [czSourceId],
            now: later,
          }),
      );
      expect(arrivals.get(String(czSourceId))?.addedLastWeek).toBe(1);
    } finally {
      await refreshCaseLawSourceArrivals(refreshDb, { now: NOW });
    }
    expect(await ownerArrivalRows()).toHaveLength(4);
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

test("a fixed-snapshot source reports its release date, not a recent run, as its currency", async () => {
  const db = drizzle({ client });
  const snapshotSourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(
    caseLawSourceRow({
      id: snapshotSourceId,
      adapterKey: ADAPTER_KEYS.PL_NSA,
      name: "pl snapshot",
      enabled: true,
      // A run an hour ago would read as current for a live publisher.
      lastSyncAt: new Date(NOW.getTime() - HOUR_IN_MS),
    }),
  );
  try {
    const coverage = await loadCoverage();
    if (Result.isError(coverage)) {
      throw coverage.error;
    }
    const poland = coverage.value.countries.find(
      ({ country }) => country === "POL",
    );
    const source = poland?.sources.find(
      ({ adapterKey }) => adapterKey === ADAPTER_KEYS.PL_NSA,
    );
    expect(source?.health).toBe(CASE_LAW_COVERAGE_HEALTH.SNAPSHOT);
    expect(source?.edition).toEqual({
      type: "snapshot",
      snapshotDate: PL_NSA_SNAPSHOT.snapshotDate,
    });
    expect(poland?.health).toBe(CASE_LAW_COVERAGE_HEALTH.SNAPSHOT);
    const czech = coverage.value.countries
      .find(({ country }) => country === "CZE")
      ?.sources.find(({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS);
    expect(czech?.edition).toEqual({ type: "live" });
  } finally {
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, snapshotSourceId));
  }
});
