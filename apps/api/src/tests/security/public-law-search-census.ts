import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import {
  CASE_LAW_SEARCH_FACETS,
  caseLawSearchPlan,
  readCaseLawSearchFacet,
  readCaseLawSearchHits,
  readCaseLawSearchTotal,
} from "@/api/handlers/case-law/decisions/search";
import { readLegislationSearchHits } from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  readCourtWeightRowsQuery,
  readFtsConfigRowsQuery,
} from "@/api/lib/case-law/case-law-config-read";
import { createCourtWeightCache } from "@/api/lib/case-law/court-weights";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import {
  PROVIDER_SEARCH_FACETS,
  providerSearchPlan,
  readProviderSearchFacet,
  readProviderSearchHits,
} from "@/api/lib/legal-search/pg-fts-legal-provider";
import type { PublicLawSharedQuery } from "@/api/lib/public-law-shared-query";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Rows the public search statements must return when they run as the
 * public-law reader: one case-law decision and one legislation document that
 * match a search word nothing else holds, a second legislation document that
 * matches but is still waiting on its index (and must not be offered), and a
 * configuration row of each kind with values nothing else carries.
 *
 * The same observation is asserted on PGlite and on the migrated schema. A
 * relation the reader can name but whose rows its policy hides returns
 * nothing without an error, so counting statements would not notice; these
 * rows do.
 */

const WORD = "zqxreadercensus";
const COURT = "Search census court";
const COURT_PATTERN = "search census court";
const FTS_LANGUAGE = "zq";
const COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("Expected a public test country.");

export type SearchCensusIds = {
  caseLawSourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  /** A later decision of the same court citing the census decision. */
  citingDecisionId: SafeId<"caseLawDecision">;
  legislationSourceId: SafeId<"legislationSource">;
  documentId: SafeId<"legislationDocument">;
  retryingDocumentId: SafeId<"legislationDocument">;
};

export const newSearchCensusIds = (): SearchCensusIds => ({
  caseLawSourceId: createSafeId<"caseLawSource">(),
  decisionId: createSafeId<"caseLawDecision">(),
  citingDecisionId: createSafeId<"caseLawDecision">(),
  legislationSourceId: createSafeId<"legislationSource">(),
  documentId: createSafeId<"legislationDocument">(),
  retryingDocumentId: createSafeId<"legislationDocument">(),
});

/** Any handle that runs owner statements: PGlite's or a Postgres client's. */
type OwnerStatements = { execute: (query: SQL) => Promise<unknown> };

export const seedSearchCensus = async (
  db: OwnerStatements,
  ids: SearchCensusIds,
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${ids.caseLawSourceId}, 'search-census', 'Search census')
  `);
  await db.execute(sql`
    INSERT INTO case_law_decisions
      (id, source_id, case_number, court, country, language, decision_date)
    VALUES
      (${ids.decisionId}, ${ids.caseLawSourceId}, 'search-census', ${COURT},
       ${COUNTRY}, 'cs', '2020-01-01'),
      (${ids.citingDecisionId}, ${ids.caseLawSourceId}, 'search-census-citing',
       ${COURT}, ${COUNTRY}, 'cs', '2024-01-01')
  `);
  await db.execute(sql`
    INSERT INTO case_law_citations
      (id, citing_decision_id, cited_decision_id, citation_text, kind)
    VALUES (
      ${createSafeId<"caseLawCitation">()}, ${ids.citingDecisionId},
      ${ids.decisionId}, 'search-census', 'precedent'
    )
  `);
  await db.execute(sql`
    INSERT INTO case_law_search_documents
      (decision_id, searchable_text, language, regconfig, tsv)
    VALUES (
      ${ids.decisionId}, ${WORD}, 'cs', 'simple',
      to_tsvector('simple', ${WORD})
    )
  `);
  await db.execute(sql`
    INSERT INTO legislation_sources (id, adapter_key, name)
    VALUES (${ids.legislationSourceId}, 'search-census', 'Search census')
  `);
  await db.execute(sql`
    INSERT INTO legislation_documents (id, source_id, eli, title, country, language)
    VALUES
      (${ids.documentId}, ${ids.legislationSourceId},
       ${`census/${ids.documentId}`}, 'Search census', ${COUNTRY}, 'cs'),
      (${ids.retryingDocumentId}, ${ids.legislationSourceId},
       ${`census/${ids.retryingDocumentId}`}, 'Search census', ${COUNTRY}, 'cs')
  `);
  await db.execute(sql`
    INSERT INTO legislation_search_documents
      (document_id, searchable_text, language, regconfig, tsv, retry_after)
    VALUES
      (${ids.documentId}, ${WORD}, 'cs', 'simple',
       to_tsvector('simple', ${WORD}), NULL),
      (${ids.retryingDocumentId}, ${WORD}, 'cs', 'simple',
       to_tsvector('simple', ${WORD}), now())
  `);
  await db.execute(sql`
    INSERT INTO case_law_fts_configs (language, regconfig, use_unaccent)
    VALUES (${FTS_LANGUAGE}, 'simple', false)
  `);
  await db.execute(sql`
    INSERT INTO case_law_court_weights
      (id, country, court_pattern, tier, tier_label, weight)
    VALUES (
      ${createSafeId<"caseLawCourtWeight">()}, ${COUNTRY}, ${COURT_PATTERN},
      3, 'supreme', 8
    )
  `);
};

export const cleanUpSearchCensus = async (
  db: OwnerStatements,
  ids: SearchCensusIds,
): Promise<void> => {
  await db.execute(
    sql`DELETE FROM case_law_court_weights WHERE court_pattern = ${COURT_PATTERN}`,
  );
  await db.execute(
    sql`DELETE FROM case_law_fts_configs WHERE language = ${FTS_LANGUAGE}`,
  );
  await db.execute(
    sql`DELETE FROM legislation_documents WHERE source_id = ${ids.legislationSourceId}`,
  );
  await db.execute(
    sql`DELETE FROM legislation_sources WHERE id = ${ids.legislationSourceId}`,
  );
  await db.execute(
    sql`DELETE FROM case_law_decisions WHERE source_id = ${ids.caseLawSourceId}`,
  );
  await db.execute(
    sql`DELETE FROM case_law_sources WHERE id = ${ids.caseLawSourceId}`,
  );
};

/** The relations whose rows the census reads, each behind its own policy. */
export const SEARCH_CENSUS_RELATIONS = [
  "case_law_search_documents",
  "case_law_court_weights",
  "case_law_fts_configs",
  "legislation_search_documents",
] as const;

/** Rows from a driver result: Postgres returns them, PGlite wraps them. */
const rowsOf = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"].filter(isRecord);
  }
  return panic("Unexpected statement result shape.");
};

const bucket = (row: Record<string, unknown>) => ({
  value: String(row["value"]),
  count: Number(row["count"]),
});

export type SearchCensusObservation = {
  ftsConfig: unknown;
  courtWeight: unknown;
  caseLawHitIds: string[];
  caseLawTotal: number;
  caseLawCourtFacet: { value: string; count: number }[];
  caseLawLanguageFacet: { value: string; count: number }[];
  providerHitIds: string[];
  providerCountryFacet: { value: string; count: number }[];
  legislationHitIds: string[];
};

export const expectedSearchCensus = (
  ids: SearchCensusIds,
): SearchCensusObservation => ({
  ftsConfig: {
    language: FTS_LANGUAGE,
    regconfig: "simple",
    useUnaccent: false,
  },
  courtWeight: {
    country: COUNTRY,
    courtPattern: COURT_PATTERN,
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  caseLawHitIds: [ids.decisionId],
  caseLawTotal: 1,
  caseLawCourtFacet: [{ value: COURT, count: 1 }],
  caseLawLanguageFacet: [{ value: "cs", count: 1 }],
  providerHitIds: [ids.decisionId],
  providerCountryFacet: [{ value: COUNTRY, count: 1 }],
  legislationHitIds: [ids.documentId],
});

/**
 * Run every search and configuration statement on `tx` and report what came
 * back. `exercised` collects the shared queries it ran.
 */
export const runSearchCensus = async (
  tx: CaseLawPublicReadTransaction,
  exercised = new Set<PublicLawSharedQuery>(),
): Promise<SearchCensusObservation> => {
  const ftsRows = await readFtsConfigRowsQuery(tx);
  exercised.add(readFtsConfigRowsQuery.publicLawSharedQuery);
  const courtWeightRows = await readCourtWeightRowsQuery(tx);
  exercised.add(readCourtWeightRowsQuery.publicLawSharedQuery);

  const configs = await createFtsConfigCache(
    async () => ftsRows,
  ).loadFtsSearchConfigs();
  const courtWeights = await createCourtWeightCache(
    async () => courtWeightRows,
  ).load();

  const plan = caseLawSearchPlan({
    body: { country: COUNTRY, court: COURT, language: "cs", query: WORD },
    configs,
    courtWeights,
    excerpt: DEFAULT_SEARCH_EXCERPT,
    limit: 10,
    parsedCursor: null,
    queryUsed: WORD,
    sort: DEFAULT_SEARCH_SORT,
  });
  const caseLawHits = rowsOf(await readCaseLawSearchHits(tx, plan));
  exercised.add(readCaseLawSearchHits.publicLawSharedQuery);
  const caseLawTotal = rowsOf(await readCaseLawSearchTotal(tx, plan));
  exercised.add(readCaseLawSearchTotal.publicLawSharedQuery);
  const caseLawFacets = new Map<string, Record<string, unknown>[]>();
  for (const facet of CASE_LAW_SEARCH_FACETS) {
    caseLawFacets.set(
      facet,
      rowsOf(await readCaseLawSearchFacet(tx, plan, facet)),
    );
  }
  exercised.add(readCaseLawSearchFacet.publicLawSharedQuery);

  const providerPlan = providerSearchPlan({
    configs,
    courtWeights,
    parsedCursor: null,
    query: {
      court: COURT,
      jurisdiction: COUNTRY,
      language: "cs",
      limit: 10,
      query: WORD,
    },
  });
  const providerHits = rowsOf(await readProviderSearchHits(tx, providerPlan));
  exercised.add(readProviderSearchHits.publicLawSharedQuery);
  const providerFacets = new Map<string, Record<string, unknown>[]>();
  for (const facet of PROVIDER_SEARCH_FACETS) {
    providerFacets.set(
      facet,
      rowsOf(await readProviderSearchFacet(tx, providerPlan, facet)),
    );
  }
  exercised.add(readProviderSearchFacet.publicLawSharedQuery);

  const legislationHits = rowsOf(
    await readLegislationSearchHits(tx, {
      body: { query: WORD, language: "cs" },
      configs,
      limit: 10,
      parsedCursor: null,
    }),
  );
  exercised.add(readLegislationSearchHits.publicLawSharedQuery);

  return {
    ftsConfig: ftsRows.find((row) => row.language === FTS_LANGUAGE),
    courtWeight: courtWeightRows.find(
      (row) => row.courtPattern === COURT_PATTERN,
    ),
    caseLawHitIds: caseLawHits.map((row) => String(row["decision_id"])),
    caseLawTotal: Number(caseLawTotal.at(0)?.["total"] ?? 0),
    caseLawCourtFacet: (caseLawFacets.get("court") ?? []).map(bucket),
    caseLawLanguageFacet: (caseLawFacets.get("language") ?? []).map(bucket),
    providerHitIds: providerHits.map((row) => String(row["decision_id"])),
    providerCountryFacet: (providerFacets.get("country") ?? []).map(bucket),
    legislationHitIds: legislationHits.map((row) => String(row["document_id"])),
  };
};
