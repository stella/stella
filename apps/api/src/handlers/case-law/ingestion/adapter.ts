import type { Result } from "better-result";

import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

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
};
