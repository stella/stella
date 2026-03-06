/** Result of parsing a single court decision from a source. */
export type IngestionResult = {
  caseNumber: string;
  ecli?: string;
  court: string;
  country: string;
  language: string;
  decisionDate?: string;
  decisionType?: string;
  fulltext?: string;
  sourceUrl?: string;
  documentUrl?: string;
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
  ) => Promise<SyncPage>;
  /** Minimum ms between requests to respect rate limits. */
  minRequestIntervalMs: number;
};
