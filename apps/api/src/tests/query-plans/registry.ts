import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import { DAY_IN_MS, Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { CITATION_DIGEST_TOP_CITING } from "@/api/handlers/case-law/decisions/citation-digest";
import {
  decisionCitationPageQuery,
  decisionCitationSummaryQuery,
} from "@/api/handlers/case-law/decisions/citation-graph";
import {
  decisionRecordQuery,
  decisionTextPresenceQuery,
} from "@/api/handlers/case-law/decisions/get";
import { listDecisionsPageQuery } from "@/api/handlers/case-law/decisions/list";
import {
  candidateDecisionRowsStatement,
  decisionIdsByIdentityQuery,
  pageDecisionRowsStatement,
} from "@/api/handlers/case-law/decisions/search";
import {
  getShardConditions,
  sitemapShardDecisionsQuery,
} from "@/api/handlers/case-law/decisions/sitemap";
import { buildLegislationFacetsQuery } from "@/api/handlers/legislation/facets";
import { buildListStatutesQuery } from "@/api/handlers/legislation/list";
import {
  statuteSitemapIndexQuery,
  statuteSitemapShardQuery,
} from "@/api/handlers/legislation/sitemap";
import {
  decisionPageSql,
  ID_PAGE_SIZE,
} from "@/api/lib/case-law/provision-state-backfill/backfill";
import {
  SITEMAP_REFRESH_PAGE_SIZE,
  sitemapRefreshPageSql,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import { corpusProjectionErasureClaimQuery } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { rehydrateCorpusIndexProviderCandidatesStatement } from "@/api/lib/legal-search/corpus-index-provider";
import {
  pendingDocumentPresenceQuery,
  remainingDocumentCandidateQuery,
} from "@/api/lib/legal-search/sk-document-backfill";
import { DOCUMENT_SCAN_ROW_BUDGET } from "@/api/lib/legal-search/sk-document-remaining-scan";
import { LIMITS } from "@/api/lib/limits";
import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";
import type { PublicLawSharedQuery } from "@/api/lib/public-law-shared-query";
import {
  SYSTEM_AUDIT_RETENTION_DAYS,
  systemAuditPurgeCandidatesQuery,
} from "@/api/lib/scheduler/tasks/system-audit-retention";
import planContracts from "@/api/tests/query-plans/contracts.json" with { type: "json" };
import type {
  AccessPath,
  HeapFetchMitigation,
} from "@/api/tests/query-plans/plan-walker";
import { QUERY_PLAN_SAMPLE } from "@/api/tests/query-plans/seed";

type QueryPlanEntry = {
  id: string;
  class: "point" | "page" | "aggregate";
  role: "root" | "public-law-reader";
  build: (tx: Transaction) => SQLWrapper;
  seed: "case-law" | "legislation";
  planMode?: "covering-index";
  heapFetchMitigation?: HeapFetchMitigation;
  contract: {
    scans: readonly AccessPath[];
    allowSeqScan?: string;
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
const citationPageSize = 10;

/** A raw `$1` statement with its one parameter bound, as a Drizzle query. */
const withFirstParameter = (text: string, value: string): SQLWrapper => {
  const [head, tail, ...rest] = text.split("$1");
  if (head === undefined || tail === undefined || rest.length > 0) {
    return panic("The statement must use $1 exactly once");
  }
  return sql`${sql.raw(head)}${value}${sql.raw(tail)}`;
};

const systemAuditPurgeCutoff = new Date(
  Temporal.Instant.from(QUERY_PLAN_SAMPLE.systemAudit.now).epochMilliseconds -
    SYSTEM_AUDIT_RETENTION_DAYS * DAY_IN_MS,
);

/** Curated production builders with a committed access path for each scan. */
export const QUERY_PLAN_REGISTRY = [
  {
    id: "system-audit.purge-candidates",
    class: "page",
    role: "root",
    build: () => systemAuditPurgeCandidatesQuery(systemAuditPurgeCutoff),
    seed: "case-law",
    contract: planContracts["system-audit.purge-candidates"],
  },
  {
    id: "case-law.outstanding-document-candidates",
    class: "page",
    role: "root",
    build: (tx) =>
      remainingDocumentCandidateQuery({
        tx,
        sourceId: QUERY_PLAN_SAMPLE.caseLaw.sourceId,
        limit: DOCUMENT_SCAN_ROW_BUDGET,
      }),
    seed: "case-law",
    planMode: "covering-index",
    contract: planContracts["case-law.outstanding-document-candidates"],
  },
  {
    id: "case-law.outstanding-document-probe",
    class: "point",
    role: "root",
    build: (tx) =>
      pendingDocumentPresenceQuery({
        sourceId: QUERY_PLAN_SAMPLE.caseLaw.sourceId,
        tx,
      }),
    seed: "case-law",
    planMode: "covering-index",
    contract: planContracts["case-law.outstanding-document-probe"],
  },
  {
    id: "case-law.ecli-identity",
    class: "point",
    role: "public-law-reader",
    build: (tx) =>
      decisionIdsByIdentityQuery({
        country: QUERY_PLAN_SAMPLE.caseLaw.country,
        familyKey: null,
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
    // A docket reads its whole case file: every stored spelling a member can
    // carry, as one membership test on the citation key and the identifier
    // rows; never a pattern. A sheet names one decision, so it reads no
    // case-file key.
    id: "case-law.docket-family-identity",
    class: "point",
    role: "public-law-reader",
    build: (tx) =>
      decisionIdsByIdentityQuery({
        country: QUERY_PLAN_SAMPLE.caseLaw.country,
        familyKey: null,
        identity: {
          type: "identifier",
          kind: "docket",
          jurisdiction: "CZE",
          value: "12 Cdo 3456/2021-7",
          family: "12 Cdo 3456/2021",
          selector: { kind: "sheet", value: "7" },
        },
        tx,
      }),
    seed: "case-law",
    contract: planContracts["case-law.docket-family-identity"],
  },
  {
    // A bare docket also reads the members stored with a sheet by their
    // case-file key. Planned as the owner until the reader's column grant
    // ships; the read itself probes for that grant first.
    id: "case-law.docket-family-key-identity",
    class: "point",
    role: "root",
    build: (tx) =>
      decisionIdsByIdentityQuery({
        country: QUERY_PLAN_SAMPLE.caseLaw.country,
        familyKey:
          docketFamilyKeyOf("12 Cdo 3456/2021", "CZE") ??
          panic("The sample docket has no case-file key"),
        identity: {
          type: "identifier",
          kind: "docket",
          jurisdiction: "CZE",
          value: "12 Cdo 3456/2021",
          family: "12 Cdo 3456/2021",
          selector: { kind: "none" },
        },
        tx,
      }),
    seed: "case-law",
    contract: planContracts["case-law.docket-family-key-identity"],
  },
  {
    id: "case-law.sitemap-refresh",
    class: "page",
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
    heapFetchMitigation: {
      type: "batched",
      pageSize: SITEMAP_REFRESH_PAGE_SIZE,
    },
    contract: planContracts["case-law.sitemap-refresh"],
  },
  {
    // A resumed page. Its generic plan is checked in the backfill's own test.
    id: "case-law.provision-backfill-page",
    class: "page",
    role: "root",
    build: () =>
      withFirstParameter(
        decisionPageSql("after", ID_PAGE_SIZE),
        QUERY_PLAN_SAMPLE.caseLaw.decisionId,
      ),
    seed: "case-law",
    contract: planContracts["case-law.provision-backfill-page"],
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
    id: "legislation.sitemap-index-read",
    class: "page",
    role: "public-law-reader",
    build: (tx) => statuteSitemapIndexQuery(tx),
    seed: "legislation",
    heapFetchMitigation: {
      type: "snapshot",
      relation: "statute_sitemap_shards",
    },
    contract: planContracts["legislation.sitemap-index-read"],
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
  {
    id: PUBLIC_LAW_SHARED_QUERY.caseLawDecisionRead,
    class: "point",
    role: "public-law-reader",
    build: (tx) =>
      decisionRecordQuery(tx, QUERY_PLAN_SAMPLE.caseLaw.decisionId),
    seed: "case-law",
    contract: planContracts[PUBLIC_LAW_SHARED_QUERY.caseLawDecisionRead],
  },
  {
    id: "case-law.search-candidate-rows",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      candidateDecisionRowsStatement(tx, {
        body: { country: sampleCountry },
        generation: QUERY_PLAN_SAMPLE.caseLaw.generation,
        ids: QUERY_PLAN_SAMPLE.caseLaw.candidateIds,
      }),
    seed: "case-law",
    heapFetchMitigation: {
      type: "batched",
      pageSize: QUERY_PLAN_SAMPLE.caseLaw.candidateIds.length,
    },
    contract: planContracts["case-law.search-candidate-rows"],
  },
  {
    id: PUBLIC_LAW_SHARED_QUERY.caseLawCorpusIndexRehydration,
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      rehydrateCorpusIndexProviderCandidatesStatement(tx, {
        generation: QUERY_PLAN_SAMPLE.caseLaw.generation,
        ids: QUERY_PLAN_SAMPLE.caseLaw.candidateIds,
      }),
    seed: "case-law",
    heapFetchMitigation: {
      type: "batched",
      pageSize: LIMITS.corpusIndexSearchCandidateLimit,
    },
    contract:
      planContracts[PUBLIC_LAW_SHARED_QUERY.caseLawCorpusIndexRehydration],
  },
  {
    id: "case-law.search-page-rows",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      pageDecisionRowsStatement(tx, {
        body: { country: sampleCountry },
        generation: QUERY_PLAN_SAMPLE.caseLaw.generation,
        ids: QUERY_PLAN_SAMPLE.caseLaw.candidateIds,
      }),
    seed: "case-law",
    heapFetchMitigation: {
      type: "batched",
      pageSize: QUERY_PLAN_SAMPLE.caseLaw.candidateIds.length,
    },
    contract: planContracts["case-law.search-page-rows"],
  },
  {
    id: "case-law.citation-page-incoming",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      decisionCitationPageQuery({
        cursorId: undefined,
        decisionId: QUERY_PLAN_SAMPLE.caseLaw.decisionId,
        direction: "incoming",
        limit: citationPageSize,
        tx,
      }),
    seed: "case-law",
    contract: planContracts["case-law.citation-page-incoming"],
  },
  {
    id: "case-law.citation-page-outgoing",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      decisionCitationPageQuery({
        cursorId: undefined,
        decisionId: QUERY_PLAN_SAMPLE.caseLaw.decisionId,
        direction: "outgoing",
        limit: citationPageSize,
        tx,
      }),
    seed: "case-law",
    contract: planContracts["case-law.citation-page-outgoing"],
  },
  {
    id: "case-law.citation-summary",
    class: "aggregate",
    role: "public-law-reader",
    build: (tx) =>
      decisionCitationSummaryQuery({
        currentYear: 2026,
        decisionId: QUERY_PLAN_SAMPLE.caseLaw.decisionId,
        tx,
      }).summary,
    seed: "case-law",
    planMode: "covering-index",
    contract: planContracts["case-law.citation-summary"],
  },
  {
    id: "case-law.top-citing-decisions",
    class: "aggregate",
    role: "public-law-reader",
    build: (tx) =>
      decisionCitationSummaryQuery({
        currentYear: 2026,
        decisionId: QUERY_PLAN_SAMPLE.caseLaw.decisionId,
        tx,
      }).topCiting(CITATION_DIGEST_TOP_CITING),
    seed: "case-law",
    planMode: "covering-index",
    contract: planContracts["case-law.top-citing-decisions"],
  },
  {
    id: "legislation.list",
    class: "page",
    role: "public-law-reader",
    build: (tx) =>
      buildListStatutesQuery(tx, {
        country: "CZE",
        query: {},
        limit: 20,
        cursor: null,
        asOf: sql`CURRENT_DATE`,
      }),
    seed: "legislation",
    heapFetchMitigation: {
      type: "heapFetchBudget",
      // Two correlated covering SubPlans, about one row each, per listed row.
      rows: 2 * 21,
      reason:
        "Each version SubPlan run reads about one row, and the SubPlans run at most once per row under the outer Limit(21).",
    },
    contract: planContracts["legislation.list"],
  },
  {
    id: "legislation.facets",
    class: "aggregate",
    role: "public-law-reader",
    build: (tx) => buildLegislationFacetsQuery(tx, "CZE"),
    seed: "legislation",
    contract: planContracts["legislation.facets"],
  },
  {
    id: "corpus-index.projection-erasure-claim",
    class: "page",
    role: "root",
    build: (tx) =>
      corpusProjectionErasureClaimQuery(tx, {
        family: "case_law",
        generation: QUERY_PLAN_SAMPLE.caseLaw.generation,
        limit: 64,
        scopedEntityIds: null,
      }),
    seed: "case-law",
    contract: planContracts["corpus-index.projection-erasure-claim"],
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
    type: "registered",
    id: PUBLIC_LAW_SHARED_QUERY.caseLawCorpusIndexRehydration,
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
    type: "registered",
    id: PUBLIC_LAW_SHARED_QUERY.caseLawDecisionRead,
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
