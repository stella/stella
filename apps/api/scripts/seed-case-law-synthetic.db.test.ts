/**
 * The synthetic case-law fixture, seeded the way the seed writes it and read
 * back through the handler behind the web's case-law search: the Postgres
 * provider a seeded local stack runs (see the dev runner).
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { PUBLIC_LAW_PAGE_SIZES } from "@stll/api-contract/limits";
import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";

import {
  caseLawDecisions,
  caseLawFtsConfigs,
  caseLawSources,
} from "@/api/db/schema";
import { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { indexDecision } from "@/api/lib/legal-search/case-law-search-index";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import { fixtureDecisionRow, fixtureSourceRow } from "./seed-case-law";
import {
  SYNTHETIC_CASE_LAW_QUERY,
  syntheticCaseLawFixtures,
} from "./seed-case-law-synthetic";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;
const SMALLEST_PAGE_SIZE = Math.min(...PUBLIC_LAW_PAGE_SIZES);

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  // The seed creates this configuration with `unaccent`, which the embedded
  // Postgres lacks; the search's headline reads it by name.
  await db.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );
  const projectionDb = executeRowsScopedDb(
    async (callback) => await db.transaction(callback),
  );

  const fixtures = syntheticCaseLawFixtures();
  const languages = new Set(
    fixtures.flatMap(({ decisions }) =>
      decisions.map(({ language }) => language),
    ),
  );
  // PGlite lacks unaccent; indexers and readers must resolve the same
  // accent-preserving configuration from the fixture database.
  await db.insert(caseLawFtsConfigs).values(
    [...languages].map((language) => ({
      language,
      regconfig: "simple",
      useUnaccent: false,
    })),
  );
  const ftsConfig = createFtsConfigCache(
    async () => await db.select().from(caseLawFtsConfigs),
  );

  for (const { source, decisions } of fixtures) {
    const sourceRow = fixtureSourceRow(source);
    await db.insert(caseLawSources).values(sourceRow);
    const rows = decisions.map((decision) =>
      fixtureDecisionRow({
        adapterKey: source.adapter_key,
        sourceId: sourceRow.id,
        decision,
      }),
    );
    await db.insert(caseLawDecisions).values(rows);
    for (const { id } of rows) {
      const indexed = await indexDecision(
        id,
        projectionDb,
        ftsConfig.resolveFtsConfig,
      );
      if (Result.isError(indexed)) {
        panic(`Could not index synthetic decision ${id}`);
      }
    }
  }

  const publicReadDb = executeRowsScopedDb(
    async (callback) => await withPublicLawReaderRole(db, callback),
  );
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) => await publicReadDb(fn);
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;
  resetPublicCaseLawConfigForTesting(caseLawDb);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  resetPublicCaseLawConfigForTesting();
  await client.close();
});

const searchPage = async (cursor: string | null) => {
  const response = await searchDecisionsHandler({
    body: {
      country: "CZE",
      query: SYNTHETIC_CASE_LAW_QUERY.CZE,
      limit: SMALLEST_PAGE_SIZE,
      ...(cursor !== null && { cursor }),
    },
    caseLawDb,
    observer: "unobserved",
  });
  if (response instanceof ElysiaCustomStatusResponse) {
    return panic(`Search answered ${String(response.code)}`);
  }
  return response;
};

test(
  "the sample query pages through every Czech fixture decision at the smallest page size",
  async () => {
    const czech = syntheticCaseLawFixtures()
      .flatMap(({ decisions }) => decisions)
      .filter(({ country }) => country === "CZE");

    const first = await searchPage(null);
    expect(first.total).toEqual({
      type: SEARCH_TOTAL_TYPE.EXACT,
      count: czech.length,
    });
    expect(first.facets?.year.length).toBeGreaterThan(2);
    expect(
      first.facets?.court.flatMap(({ courts }) => courts).length,
    ).toBeGreaterThan(2);

    const pages = [first];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await searchPage(cursor);
      pages.push(page);
      cursor = page.nextCursor;
    }

    expect(pages.length).toBe(Math.ceil(czech.length / SMALLEST_PAGE_SIZE));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const caseNumbers = pages.flatMap(({ hits }) =>
      hits.map(({ caseNumber }) => caseNumber),
    );
    const courts = new Set(
      pages.flatMap(({ hits }) => hits.map(({ court }) => court)),
    );
    for (const court of [
      "Nejvyšší soud",
      "Nejvyšší správní soud",
      "Ústavní soud",
      "Okresní soud v Ostravě",
    ]) {
      expect(courts.has(court)).toBe(true);
    }
    expect(caseNumbers.toSorted()).toEqual(
      czech.map(({ case_number }) => case_number).toSorted(),
    );
  },
  DB_TEST_TIMEOUT_MS,
);
