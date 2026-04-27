import type { Result } from "better-result";

import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/**
 * Empty AST placeholder for adapters without a parser.
 * Typed as a narrow object so it's assignable to the
 * documentAst union without casts.
 */
export type EmptyAst = Record<string, never>;

/**
 * Constant empty AST for adapters without a parser.
 * Avoids `{} as EmptyAst` casts at every call site.
 */
export const EMPTY_AST: EmptyAst = {};

/** Result of parsing a single court decision from a source. */
export type IngestionResult = {
  caseNumber: string;
  ecli?: string | undefined;
  court: string;
  country: string;
  language: string;
  decisionDate?: string | undefined;
  decisionType?: string | undefined;
  fulltext?: string | undefined;
  sourceUrl?: string | undefined;
  documentUrl?: string | undefined;
  metadata: Record<string, unknown>;
  rawHash: string;
  /** Parsed document AST, or empty object for courts without a parser. */
  documentAst: DocumentAst | EmptyAst;
  /** Parser version that produced the AST. Enables lazy re-parsing. */
  parserVersion?: number | undefined;
  /**
   * Raw source from the court website (HTML, JSON string, etc.)
   * stored verbatim for future re-parsing without re-downloading.
   */
  sourceRaw?: string | undefined;
  /** Binary raw source (e.g., PDF bytes) for S3 upload. */
  sourceRawBytes?: Uint8Array | undefined;
  /** MIME type of sourceRaw/sourceRawBytes for S3 storage. */
  sourceRawContentType?: string | undefined;
};

/** A page of ingestion results with an optional cursor. */
export type SyncPage = {
  decisions: IngestionResult[];
  nextCursor: string | null;
};

/**
 * Interface for court data source adapters.
 *
 * Each adapter knows how to paginate through a specific
 * court's API or website and parse decisions into a
 * normalized format.
 */
export type SourceAdapter = {
  key: string;
  name: string;
  country: string;
  language: string;
  fetchPage: (
    cursor: string | null,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Result<SyncPage, AdapterFetchError>>;
  /** Minimum ms between requests to respect rate limits. */
  minRequestIntervalMs: number;
  /** Override per-page timeout (ms). Defaults to ADAPTER_TIMEOUT.PAGE. */
  pageTimeoutMs?: number | undefined;
  /**
   * Max pages per pipeline cycle. Shorter cycles persist cursors
   * more often, reducing lost work on interruptions. Defaults
   * to MAX_SYNC_PAGES (100). Slow adapters (sequential probing)
   * should set this lower (e.g., 10).
   */
  maxSyncPages?: number | undefined;
  /**
   * Override per-adapter cycle timeout (ms). Defaults to
   * MAX_CYCLE_MS (10 min). Adapters doing lightweight work
   * per page (metadata-only, no PDF) can use longer cycles
   * to maximize throughput per cursor persist.
   */
  maxCycleMs?: number | undefined;
  /**
   * Fetch the total number of decisions available from
   * the source. Returns null if the source doesn't expose
   * a count endpoint or if the request fails.
   */
  getTotalCount?: (signal: AbortSignal) => Promise<number | null>;
};
