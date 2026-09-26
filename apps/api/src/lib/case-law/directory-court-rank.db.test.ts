import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";
import { resolveUsCourt } from "@stll/api-contract/us-courts";

import {
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  caseLawSearchPlan,
  readCaseLawSearchHits,
} from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import {
  providerSearchPlan,
  readProviderSearchHits,
} from "@/api/lib/legal-search/pg-fts-legal-provider";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const WORD = "zqxdirectoryrank";

/**
 * A United States court at each directory tier, in rank order: the Supreme
 * Court, a circuit, and a trial and a special court sharing the bottom tier.
 * Only the first carries a name the registry still ranks.
 */
const COURT_IDS = ["scotus", "ca1", "mad", "masslandct"] as const;

const rowsOf = (result: unknown): Record<string, unknown>[] => {
  const rows =
    typeof result === "object" && result !== null && "rows" in result
      ? result.rows
      : result;
  return Array.isArray(rows) ? rows : [];
};

test("both Postgres searches rank a United States decision by its court id's tier", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  // The headline configuration: migrations create it, the schema push does not.
  await db.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  const decisions = COURT_IDS.map((courtId) => {
    const resolution = resolveUsCourt(courtId);
    if (resolution.type !== "accepted") {
      throw new Error(`${courtId} is not an accepted court`);
    }
    return {
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `rank-${courtId}`,
      court: resolution.court.canonicalName,
      courtId,
      country: "USA",
      language: "en",
      decisionDate: "2020-01-01",
    };
  });
  await db.insert(caseLawDecisions).values(decisions);
  // The same text for every decision: only the court separates them.
  await db.insert(caseLawSearchDocuments).values(
    decisions.map(({ id }) => ({
      decisionId: id,
      searchableText: WORD,
      language: "en",
      regconfig: "simple",
      tsv: sql`to_tsvector('simple', ${WORD})`,
    })),
  );

  const configs = await createFtsConfigCache(async () => [
    { language: "en", regconfig: "simple", useUnaccent: false },
  ]).loadFtsSearchConfigs();
  const courtWeights = courtWeightMapFromSeed();
  // SAFETY: the owner handle has the read surface the public reader has.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite owner handle stands in for the public read transaction
  const tx = db as unknown as CaseLawPublicReadTransaction;
  const courtIdOf = new Map(decisions.map(({ courtId, id }) => [id, courtId]));
  const scored = (rows: Record<string, unknown>[], scoreColumn: string) =>
    rows.map((row) => ({
      courtId: courtIdOf.get(String(row["decision_id"])),
      score: Number(row[scoreColumn]),
    }));

  const search = scored(
    rowsOf(
      await readCaseLawSearchHits(
        tx,
        caseLawSearchPlan({
          body: { country: "USA", query: WORD },
          configs,
          courtWeights,
          excerpt: DEFAULT_SEARCH_EXCERPT,
          limit: 10,
          parsedCursor: null,
          queryUsed: WORD,
          sort: DEFAULT_SEARCH_SORT,
        }),
      ),
    ),
    "sort_key",
  );
  const provider = scored(
    rowsOf(
      await readProviderSearchHits(
        tx,
        providerSearchPlan({
          configs,
          courtWeights,
          parsedCursor: null,
          query: { jurisdiction: "USA", limit: 10, query: WORD },
        }),
      ),
    ),
    "score",
  );

  for (const hits of [search, provider]) {
    expect(hits.map(({ courtId }) => courtId).slice(0, 2)).toEqual([
      "scotus",
      "ca1",
    ]);
    const scoreOf = new Map(hits.map(({ courtId, score }) => [courtId, score]));
    const [supreme, appellate, trial, special] = COURT_IDS.map(
      (courtId) => scoreOf.get(courtId) ?? Number.NaN,
    );
    // Apex above a circuit above the bottom tier, which the trial and the
    // special court share. By name the circuit would sit with the bottom tier.
    expect(supreme).toBeGreaterThan(appellate ?? Number.NaN);
    expect(appellate).toBeGreaterThan(trial ?? Number.NaN);
    expect(trial).toBe(special ?? Number.NaN);
  }
  await client.close();
}, 60_000);
