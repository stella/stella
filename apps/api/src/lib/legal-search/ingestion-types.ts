import type { Result } from "better-result";

import type { DocumentAst } from "@/api/lib/case-law/document-ast";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

export { EMPTY_AST };
export type { EmptyAst };

/** Mirrors the publisher-identity columns in the case-law schema. */
export const SOURCE_DOCUMENT_ID_MAX_LENGTH = 256;

export const isPersistableSourceDocumentId = (value: string): boolean =>
  value.length > 0 && value.length <= SOURCE_DOCUMENT_ID_MAX_LENGTH;

/** Result of parsing a single court decision from a source. */
export type IngestionResult = {
  caseNumber: string;
  /**
   * True when `caseNumber` is a durable ingestion placeholder rather than a
   * publisher docket. Identified-row refreshes preserve an already recovered
   * docket and its citation key when a later partial listing carries this.
   */
  caseNumberIsPlaceholder?: boolean | undefined;
  /**
   * True when the publisher listing proves this document exists but the
   * adapter could not recover its detail payload. The first observation is
   * still durable; a later listing-only refresh must not replace detail state
   * that an earlier fetch or repair already recovered.
   */
  isListingOnly?: boolean | undefined;
  /**
   * The publisher's own identifier for this document. Supply it whenever the
   * source has one: it is what makes a decision identifiable. A case number
   * does not, because courts number dockets per court and one source often
   * covers many, so the same number recurs across unrelated decisions.
   *
   * Omit it only where the source publishes no such id.
   */
  sourceDocumentId?: string | undefined;
  /**
   * Other exact publisher identifiers for this same document. Emit every
   * alternate identity visible with the canonical `sourceDocumentId`; the
   * pipeline atomically reserves all of them to one durable decision UUID, so
   * canonical/fallback observations converge in either order. Identities must
   * fit `SOURCE_DOCUMENT_ID_MAX_LENGTH`; adapters should discard a malformed
   * alias at their publisher boundary instead of poisoning the whole page.
   */
  sourceDocumentIdAliases?: readonly string[] | undefined;
  /**
   * Deterministic identities emitted by an older or degraded observation that
   * may adopt an existing registry owner but are not exact enough to reserve
   * when unclaimed. Use this for content-addressed repair fingerprints, never
   * for an alternate publisher key.
   */
  sourceDocumentIdRepairAliases?: readonly string[] | undefined;
  /**
   * Exact source URLs emitted by an older adapter version for this same
   * publisher document. This is a narrowly scoped identity-migration hint:
   * the pipeline may use it to attach a newly learned `sourceDocumentId` to
   * the right legacy null-id row without guessing from a shared docket.
   */
  legacySourceUrls?: readonly string[] | undefined;
  /**
   * Sheet number within the court file, where the source appends one to the
   * docket. Split it out with `splitCaseReference` rather than leaving it on
   * `caseNumber`: a citation names the docket alone, so a number carrying a
   * sheet matches nothing.
   */
  sheetNumber?: string | undefined;
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
  /**
   * Structural sections, when the adapter's parser can derive them from
   * the document itself. Omitted by adapters that rely on the
   * wording-based `segmentDecision` fallback in the pipeline.
   */
  sections?: DecisionSection[] | undefined;
  /** Parser version that produced the AST. Enables lazy re-parsing. */
  parserVersion?: number | undefined;
  /**
   * Raw source from the court website (HTML, JSON string, etc.)
   * stored verbatim for future re-parsing without re-downloading.
   */
  sourceRaw?: string | undefined;
  /**
   * The publisher's own cited-decisions list, where the source supplies
   * one (case numbers as published). Not stored on the row: it is the
   * ground truth the pipeline measures citation extraction against.
   */
  publisherCitedCases?: readonly string[] | undefined;
  /** Binary raw source (e.g., PDF bytes) for S3 upload. */
  sourceRawBytes?: Uint8Array | undefined;
  /** MIME type of sourceRaw/sourceRawBytes for S3 storage. */
  sourceRawContentType?: string | undefined;
};

/**
 * What a source says it holds for the slice just crawled, against what the
 * crawl actually produced.
 *
 * Coverage is otherwise unknowable: a crawl that silently stops early looks
 * exactly like a slice with fewer decisions in it. Reporting the source's
 * own count next to the collected count turns that into a number the
 * reconciliation pass can act on. Adapters whose source publishes no count
 * omit it, and their slices are simply not tracked.
 */
export type SliceCoverage = {
  /**
   * The crawl slice these counts describe — a calendar day for date-cursor
   * adapters. Stable across re-crawls, since it keys the ledger row.
   */
  slice: string;
  /** How many records the source says the slice contains. */
  reported: number;
  /** How many this crawl produced for it. */
  collected: number;
};

/** A page of ingestion results with an optional cursor. */
export type SyncPage = {
  decisions: IngestionResult[];
  nextCursor: string | null;
  /** Present on the page that completes a slice; see `SliceCoverage`. */
  coverage?: SliceCoverage | undefined;
};

/**
 * A stored raw payload plus the persisted fields an adapter needs to rebuild
 * the ingestion result it once produced from it. Every field comes off the
 * decision row, so a re-parse reads object storage and the database only.
 *
 * `raw` is the object verbatim, as bytes: adapters store XHTML, JSON and PDF
 * alike, and only the adapter knows how to decode its own.
 */
export type StoredRawReparseInput = {
  raw: Uint8Array;
  /** Media type recorded with the payload; null on rows stored without one. */
  contentType: string | null;
  caseNumber: string;
  sourceDocumentId: string | null;
  language: string;
  court: string;
  ecli: string | null;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Why a stored payload produced no result. Enumerated so a caller can report
 * each cause separately: "10 rows rejected" hides whether the parser broke or
 * the rows predate a metadata field.
 */
export const STORED_RAW_REPARSE_REJECTION = {
  /** The row lacks a field the adapter needs to rebuild the result. */
  INCOMPLETE_METADATA: "incomplete-metadata",
  /** Re-parsing would target a different decision than the selected row. */
  IDENTITY_MISMATCH: "identity-mismatch",
  /** Historical normalization erased source distinctions the parser needs. */
  RAW_FIDELITY_LOST: "raw-fidelity-lost",
  /** The stored media type is not one this adapter parses. */
  UNSUPPORTED_CONTENT: "unsupported-content",
  /** The payload parsed to nothing that could be stored as a decision. */
  NO_DOCUMENT: "no-document",
} as const;

export type StoredRawReparseRejection =
  (typeof STORED_RAW_REPARSE_REJECTION)[keyof typeof STORED_RAW_REPARSE_REJECTION];

export type StoredRawReparseOutcome =
  | { type: "parsed"; result: IngestionResult }
  | {
      type: "rejected";
      rejection: StoredRawReparseRejection;
      /** Row-specific context for the operator; safe to print. */
      detail: string;
    };

/**
 * Interface for court data source adapters.
 *
 * Each adapter knows how to paginate through a specific
 * court's API or website and parse decisions into a
 * normalized format.
 */
export type SourceAdapter = {
  key: AdapterKey;
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
   * Re-parse a payload this adapter already stored into the ingestion result
   * it would produce for that payload today, without contacting the
   * publisher. The result goes through the same pipeline a crawl feeds, so
   * whatever the parser now derives (AST, sections, fulltext, keywords, and
   * the hash over them) is applied by the same writes.
   *
   * Optional. It exists only for adapters whose stored payload is one
   * decision: where the payload is a list endpoint's page covering many
   * decisions, one blob cannot be mapped back to one row, and the adapter
   * omits this rather than guessing.
   *
   * The outcome may be returned directly by a parser that needs no I/O, or
   * as a promise by one that does (an office-format extractor, say).
   */
  reparseStoredRaw?: (
    stored: StoredRawReparseInput,
  ) => StoredRawReparseOutcome | Promise<StoredRawReparseOutcome>;
  /**
   * Fetch the total number of decisions available from
   * the source. Returns null if the source doesn't expose
   * a count endpoint or if the request fails.
   */
  getTotalCount?: (signal: AbortSignal) => Promise<number | null>;
};

/** Preserve an adapter's literal registry key while contextualizing its API. */
export const defineSourceAdapter = <const TKey extends string>(
  adapter: SourceAdapter & { readonly key: TKey },
): SourceAdapter & { readonly key: TKey } => adapter;
