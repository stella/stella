import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import {
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { caseLawSearchPlan } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import { providerSearchPlan } from "@/api/lib/legal-search/pg-fts-legal-provider";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const WORD = "zqxdecisiontype";

test("both Postgres searches match stated types regardless of casing within the requested country", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await db.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  const decisions = ["CZE", "SVK"].flatMap((country) =>
    ["nález", "Nález", "uznesenie", null].map((decisionType, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      country,
      language: country === "CZE" ? "cs" : "sk",
      court: country === "CZE" ? "Ústavní soud" : "Ústavný súd SR",
      caseNumber: `${country}-${index}`,
      decisionType,
      decisionDate: "2020-01-01",
    })),
  );
  await db.insert(caseLawDecisions).values(decisions);
  await db.insert(caseLawSearchDocuments).values(
    decisions.map(({ id, language }) => ({
      decisionId: id,
      searchableText: WORD,
      language,
      regconfig: "simple",
      tsv: sql`to_tsvector('simple', ${WORD})`,
    })),
  );
  const configs = await createFtsConfigCache(async () => [
    { language: "cs", regconfig: "simple", useUnaccent: false },
    { language: "sk", regconfig: "simple", useUnaccent: false },
  ]).loadFtsSearchConfigs();
  const courtWeights = courtWeightMapFromSeed();
  for (const country of ["CZE", "SVK"]) {
    const expected = decisions
      .filter(
        (row) =>
          row.country === country &&
          row.decisionType?.toLowerCase() === "nález",
      )
      .map(({ id }) => String(id))
      .toSorted();
    for (const decisionType of ["nález", "Nález", "NÁLEZ"]) {
      const search = caseLawSearchPlan({
        body: { country, query: WORD, decisionType },
        configs,
        courtWeights,
        excerpt: DEFAULT_SEARCH_EXCERPT,
        limit: 10,
        parsedCursor: null,
        queryUsed: WORD,
        sort: DEFAULT_SEARCH_SORT,
      });
      const provider = providerSearchPlan({
        configs,
        courtWeights,
        parsedCursor: null,
        query: {
          jurisdiction: country,
          limit: 10,
          query: WORD,
          documentType: decisionType,
        },
      });
      for (const plan of [search, provider]) {
        const result = await db.execute(plan.hits);
        expect(
          result.rows.map((row) => String(row["decision_id"])).toSorted(),
        ).toEqual(expected);
      }
    }
  }
  await client.close();
}, 60_000);
