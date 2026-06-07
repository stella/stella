import type { DocumentAst } from "@stll/case-law/document-ast";

import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";
import type { FacetBucket } from "@/api/lib/search/types";

/**
 * Provider-neutral contract for legal-corpus search. The app calls this,
 * never an engine directly, so swapping Postgres FTS for Quickwit (and
 * back) is a config change, not a code rewrite. The corpus is global
 * (public records): there are no tenant/workspace fields here.
 */

export const LEGAL_SEARCH_ENGINES = ["pg-fts", "quickwit"] as const;
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
  court: string;
  country: string;
  language: string;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  /** Escaped + <mark>-highlighted snippet HTML. */
  headline: string | null;
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
 * (Quickwit cannot produce exact counts on broad queries cheaply, and
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
 * Read-side abstraction the app calls for legal-corpus search. Indexing,
 * deletion, and redaction are NOT here: like the shipped case-law FTS,
 * those are daemon-loop / dedicated-module concerns (search-index.ts,
 * quickwit-index.ts), not request-path operations.
 */
export type LegalSearchProvider = {
  search: (query: LegalSearchQuery) => Promise<LegalSearchResult>;
  /** Canonical text/AST for the AI reader; served from object storage. */
  getDocumentContext: (
    decisionId: SafeId<"caseLawDecision">,
  ) => Promise<LegalDocumentContext | null>;
};
