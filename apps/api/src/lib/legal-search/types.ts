import type { Result } from "better-result";

import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { SafeId } from "@/api/lib/branded-types";
import type { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import type { FacetBucket } from "@/api/lib/search/types";

/**
 * Provider-neutral contract for legal-corpus search. The app calls this,
 * never an engine directly, so swapping Postgres FTS for corpus index (and
 * back) is a config change, not a code rewrite. The corpus is global
 * (public records): there are no tenant/workspace fields here.
 */

export const LEGAL_SEARCH_ENGINES = ["pg-fts", "corpus-index"] as const;
export type LegalSearchEngine = (typeof LEGAL_SEARCH_ENGINES)[number];

export type LegalSearchQuery = {
  query: string;
  /** Document family to search; selects the index family. Default case_law. */
  documentFamily?: CorpusFamily | undefined;
  /** Maps from the decision's `country`. Required scoping in practice. */
  jurisdiction?: string | undefined;
  /** Maps from the decision's `decisionType`. */
  documentType?: string | undefined;
  court?: string | undefined;
  source?: SafeId<"caseLawSource"> | undefined;
  language?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  cursor?: string | undefined;
  limit: number;
};

export type LegalSearchHit = {
  decisionId: string;
  caseNumber: string;
  ecli: string | null;
  identifiers: DecisionIdentifiers;
  court: string;
  country: string;
  language: string;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  /** Escaped + <mark>-highlighted snippet HTML. */
  headline: string | null;
  /**
   * AST block anchor of the passage the snippet came from, for a deep link
   * into the reader. Null when the provider scores whole documents, or when
   * the matching passage came from unstructured text with no block to anchor.
   */
  anchorId: string | null;
  /**
   * Passages of this document that matched. A breadth signal alongside the
   * best-passage score; 1 from a document-scoring provider.
   */
  matchingPassages: number;
  citationCount: number;
  citationAuthority: number;
  /** Internal blended ranking score; also the cursor sort key. */
  score: number;
  createdAt: string;
};

export type LegalSearchFacets = {
  court: FacetBucket[];
  country: FacetBucket[];
  language: FacetBucket[];
} | null;

/**
 * Page-shaped result. Uses `hits` (not `items`) deliberately: the
 * shipped case-law search endpoint and its web consumer already key on
 * `hits`/`facets`/`nextCursor`, so the provider keeps that shape rather
 * than forcing a frontend break. `totalCount` is intentionally dropped
 * (corpus index cannot produce exact counts on broad queries cheaply, and
 * the UI does not read it).
 */
export type LegalSearchResult = {
  hits: LegalSearchHit[];
  facets: LegalSearchFacets;
  nextCursor: string | null;
  limit: number;
};

export type LegalDocumentContext = {
  decisionId: string;
  caseNumber: string;
  court: string;
  fulltext: string | null;
  documentAst: DocumentAst | EmptyAst | null;
};

/**
 * Facets for the *unsearched* browse page. Separate from `LegalSearchFacets`
 * because it answers a different question: those describe one result set, these
 * describe the whole corpus, so they are computed without a text query and are
 * cacheable for minutes.
 */
export type LegalBrowseFacetsQuery = {
  /** Document family to facet; selects the index family. Default case_law. */
  documentFamily?: CorpusFamily | undefined;
  /** Maps from the decision's `country`; scopes every facet to it. */
  jurisdiction?: string | undefined;
  /**
   * Sources whose redistribution is currently revoked. Resolved by the caller
   * on every request rather than inside a provider, because it is an input
   * that changes the answer: a cache keyed without it would keep serving a
   * revoked source's buckets for a whole window. Providers that re-evaluate
   * the policy in their own query (pg-fts) need not read it; its presence in
   * the key is what makes their cached answer expire with the policy too.
   */
  excludedSourceIds: readonly string[];
  /** Maximum buckets per facet. */
  limit: number;
};

export type LegalBrowseFacets = {
  country: FacetBucket[];
  court: FacetBucket[];
  year: FacetBucket[];
};

/**
 * Read-side abstraction the app calls for legal-corpus search. Indexing,
 * deletion, and redaction are NOT here: like the shipped case-law FTS,
 * those are daemon-loop / dedicated-module concerns (search-index.ts,
 * corpus-index.ts), not request-path operations.
 */
export type LegalSearchProvider = {
  search: (query: LegalSearchQuery) => Promise<LegalSearchResult>;
  /**
   * Corpus-wide facet counts for the browse page. Returns a Result rather
   * than throwing: facets are navigational, and the caller degrades to an
   * empty set instead of failing the page.
   */
  browseFacets: (
    query: LegalBrowseFacetsQuery,
  ) => Promise<Result<LegalBrowseFacets, LegalBrowseFacetsError>>;
  /** Canonical text/AST for the AI reader; served from object storage. */
  getDocumentContext: (
    decisionId: SafeId<"caseLawDecision">,
  ) => Promise<LegalDocumentContext | null>;
};
