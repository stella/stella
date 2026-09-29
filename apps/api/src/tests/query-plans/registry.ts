import { panic } from "better-result";
import type { SQLWrapper } from "drizzle-orm";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import type { Transaction } from "@/api/db/root";
import { decisionTextPresenceQuery } from "@/api/handlers/case-law/decisions/get";
import { listDecisionsPageQuery } from "@/api/handlers/case-law/decisions/list";
import { decisionIdsByIdentityQuery } from "@/api/handlers/case-law/decisions/search";
import {
  getShardConditions,
  sitemapShardDecisionsQuery,
} from "@/api/handlers/case-law/decisions/sitemap";
import { statuteSitemapShardQuery } from "@/api/handlers/legislation/sitemap";
import {
  SITEMAP_REFRESH_PAGE_SIZE,
  sitemapRefreshPageSql,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import { LIMITS } from "@/api/lib/limits";
import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";
import type { PublicLawSharedQuery } from "@/api/lib/public-law-shared-query";
import planContracts from "@/api/tests/query-plans/contracts.json" with { type: "json" };
import type { AccessPath } from "@/api/tests/query-plans/plan-walker";
import { QUERY_PLAN_SAMPLE } from "@/api/tests/query-plans/seed";

type QueryPlanEntry = {
  id: string;
  class: "point" | "page" | "aggregate";
  role: "root" | "public-law-reader";
  build: (tx: Transaction) => SQLWrapper;
  seed: "case-law" | "legislation";
  planMode?: "covering-index";
  contract: {
    scans: readonly AccessPath[];
    allowSeqScan?: boolean;
  };
};

const shardConditions = getShardConditions({
  country: "CZE",
  year: "2010",
  month: "02",
  bucket: "all",
});
if (!Array.isArray(shardConditions)) {
  panic("The query-plan shard fixture must be valid");
}
const sampleCountry =
  publicCaseLawCountry("CZE") ?? panic("The query-plan country must be public");

/** Curated production builders with a committed access path for each scan. */
export const QUERY_PLAN_REGISTRY = [
  {
    id: "case-law.ecli-identity",
    class: "point",
    role: "public-law-reader",
    build: (tx) =>
      decisionIdsByIdentityQuery({
        country: QUERY_PLAN_SAMPLE.caseLaw.country,
        identity: {
          type: "identifier",
          kind: "ecli",
          value: QUERY_PLAN_SAMPLE.caseLaw.sharedEcli,
        },
        tx,
      }),
    seed: "case-law",
    contract: planContracts["case-law.ecli-identity"],
  },
  {
    id: "case-law.sitemap-refresh",
    class: "aggregate",
    role: "root",
    // A resumed page, so the plan covers the row comparison on the index keys.
    build: () =>
      sitemapRefreshPageSql({
        country: QUERY_PLAN_SAMPLE.caseLaw.country,
        cursor: {
          decisionDate: "2010-02-01",
          id: QUERY_PLAN_SAMPLE.caseLaw.decisionId,
          sourceId: "00000000-0000-0000-0000-000000000000",
          updatedAt: "2020-01-01T00:00:00Z",
        },
        pageSize: SITEMAP_REFRESH_PAGE_SIZE,
        phase: "dated",
      }),
    seed: "case-law",
    planMode: "covering-index",
    contract: planContracts["case-law.sitemap-refresh"],
  },
  {
    id: "case-law.sitemap-shard-read",
    class: "page",
    role: "public-law-reader",
    build: (tx) => sitemapShardDecisionsQuery(tx, shardConditions),
    seed: "case-law",
    contract: planContracts["case-law.sitemap-shard-read"],
  },
  {
    id: "legislation.sitemap-shard-read",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      statuteSitemapShardQuery({
        query: QUERY_PLAN_SAMPLE.legislation,
        tx,
      }),
    seed: "legislation",
    contract: planContracts["legislation.sitemap-shard-read"],
  },
  {
    id: "case-law.decisions-list",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      listDecisionsPageQuery({
        cursor: undefined,
        limit: LIMITS.caseLawSearchPageSizeDefault,
        query: { country: sampleCountry },
        tx,
      }),
    seed: "case-law",
    contract: planContracts["case-law.decisions-list"],
  },
  {
    id: PUBLIC_LAW_SHARED_QUERY.caseLawDecisionTextPresence,
    class: "point",
    role: "public-law-reader",
    build: (tx) =>
      decisionTextPresenceQuery(tx, QUERY_PLAN_SAMPLE.caseLaw.decisionId),
    seed: "case-law",
    contract:
      planContracts[PUBLIC_LAW_SHARED_QUERY.caseLawDecisionTextPresence],
  },
] as const satisfies readonly QueryPlanEntry[];

type SharedQueryDisposition =
  | { type: "registered"; id: string }
  | { type: "excluded"; reason: string };

/** Explicit disposition for every shared query id; adding one requires a choice. */
export const PUBLIC_LAW_PLAN_DISPOSITION = {
  [PUBLIC_LAW_SHARED_QUERY.caseLawAnalysis]: {
    type: "excluded",
    reason: "Subject-id relational read has no standalone statement builder.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawBrowseFacets]: {
    type: "excluded",
    reason: "Facets come from the corpus-index provider, not PostgreSQL.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawCorpusIndexRehydration]: {
    type: "excluded",
    reason: "Candidate-id batch size changes the statement shape.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawCorpusStatus]: {
    type: "excluded",
    reason: "Status combines several separately built statements.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawCourtActivity]: {
    type: "excluded",
    reason: "Court activity has a date-window-dependent aggregate shape.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawCourtWeights]: {
    type: "excluded",
    reason: "Reads the small court-weight configuration table.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawCoverageArrivals]: {
    type: "excluded",
    reason: "Coverage arrival windows need their own seeded profile.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawCoverageSources]: {
    type: "excluded",
    reason: "Coverage mixes source metadata and decision counts.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawDecisionRead]: {
    type: "excluded",
    reason: "Subject-gated detail read contains multiple statements.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawDecisionTextPresence]: {
    type: "registered",
    id: PUBLIC_LAW_SHARED_QUERY.caseLawDecisionTextPresence,
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawDocumentContext]: {
    type: "excluded",
    reason: "Subject-id relational read has no standalone statement builder.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawFtsConfigs]: {
    type: "excluded",
    reason: "Reads the small FTS configuration table.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawLanguageAlternates]: {
    type: "excluded",
    reason: "Language-group array size changes the window query shape.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawNonRedistributableSources]: {
    type: "excluded",
    reason: "Reads the small source registry; two statements share this id.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawProviderSearchFacet]: {
    type: "excluded",
    reason: "Facet query depends on the corpus-index provider.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawProviderSearchHits]: {
    type: "excluded",
    reason: "Candidate hits depend on the corpus-index provider.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawSearchFacet]: {
    type: "excluded",
    reason: "Facet SQL varies by filter and facet kind.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawSearchHits]: {
    type: "excluded",
    reason: "Search SQL varies by rank, cursor and filter profile.",
  },
  [PUBLIC_LAW_SHARED_QUERY.caseLawSearchTotal]: {
    type: "excluded",
    reason: "Search total SQL varies by filter profile.",
  },
  [PUBLIC_LAW_SHARED_QUERY.legislationNonRedistributableSources]: {
    type: "excluded",
    reason: "Reads the small legislation source registry.",
  },
  [PUBLIC_LAW_SHARED_QUERY.legislationSearchHits]: {
    type: "excluded",
    reason: "FTS query varies by term and cursor profile.",
  },
} as const satisfies Record<PublicLawSharedQuery, SharedQueryDisposition>;
