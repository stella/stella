import { panic } from "better-result";
import type { Result } from "better-result";

import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";

import type { DocumentAst } from "@/api/lib/case-law/document-ast";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import type {
  AdapterKey,
  CaseLawJurisdiction,
} from "@/api/lib/legal-search/ingestion-constants";

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
   * Every identifier the publisher states for this decision. The pipeline
   * always adds `caseNumber` and `ecli`, so adapters may omit this until they
   * expose neutral or reporter citations.
   */
  identifiers?: DecisionIdentifiers | undefined;
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
 * What a source says it holds for a slice, against what is held for it.
 *
 * Coverage is otherwise unknowable: a walk that silently stops early looks
 * exactly like a slice with fewer decisions in it. Recording the source's own
 * count next to the collected count turns that into a number the ledger can
 * select on.
 *
 * Written by the reconciliation loop alone. A crawl cannot state it honestly:
 * a forward-only cursor does not know which slice it has finished, so a count
 * taken mid-slice reads as a shortfall and a count taken at the end reads as
 * complete whatever the crawl skipped.
 */
export type SliceCoverage = {
  /**
   * The slice these counts describe — a calendar day for date-cursor
   * adapters. Stable across re-walks, since it keys the ledger row.
   */
  slice: string;
  /** How many records the source says the slice contains. */
  reported: number;
  /** How many of them are held. */
  collected: number;
};

/** A page of ingestion results with an optional cursor. */
export type SyncPage = {
  decisions: IngestionResult[];
  nextCursor: string | null;
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
 * How a listing item would be keyed once stored, mirroring the two halves of
 * the decision identity index: the publisher's own document id where the item
 * carries one, the docket plus its language otherwise.
 *
 * `unidentifiable` is the item an ingest also drops: with nothing to key the
 * decision on it can never be held, so it must not be counted as missing
 * either — a slice that counted it would stay short forever.
 */
export type ListingIdentity =
  | { type: "document"; sourceDocumentId: string }
  | { type: "case-number"; caseNumber: string; language: string }
  | { type: "unidentifiable" };

/**
 * Mirrors `case_law_reconciliation_items.identity_key`. A key longer than the
 * column cannot be parked, so it cannot be tracked to a fixed point either.
 */
export const LISTING_IDENTITY_KEY_MAX_LENGTH = 320;

const IDENTITY_KEY_PREFIX = {
  DOCUMENT: "document:",
  CASE_NUMBER: "case-number:",
} as const;

/**
 * The stable string form of a keyable identity, or `null` when there is none
 * to key on. Both `unidentifiable` and an over-long key answer `null`: they
 * mean the same thing to every caller — this item can be neither looked up
 * nor parked, so it is excluded from what a slice is measured against.
 */
const unboundedListingIdentityKey = (
  identity: ListingIdentity,
): string | null => {
  switch (identity.type) {
    case "document":
      return identity.sourceDocumentId.length === 0
        ? null
        : `${IDENTITY_KEY_PREFIX.DOCUMENT}${identity.sourceDocumentId}`;
    case "case-number":
      // Both halves, because either one empty produces a key the parser
      // below rejects, and the round-trip is the property this pair exists
      // to guarantee. An adapter that trims a docket to nothing gets an
      // unkeyable identity rather than a key nothing can read back.
      return identity.caseNumber.length === 0 || identity.language.length === 0
        ? null
        : `${IDENTITY_KEY_PREFIX.CASE_NUMBER}${identity.language}:${identity.caseNumber}`;
    case "unidentifiable":
      return null;
    default: {
      const exhaustive: never = identity;
      return panic(`Unhandled listing identity: ${JSON.stringify(exhaustive)}`);
    }
  }
};

export const listingIdentityKey = (
  identity: ListingIdentity,
): string | null => {
  const key = unboundedListingIdentityKey(identity);
  return key !== null && key.length <= LISTING_IDENTITY_KEY_MAX_LENGTH
    ? key
    : null;
};

/**
 * The identity a key names, or `null` when no current rule produces that key.
 *
 * The inverse of `listingIdentityKey`, deliberately its neighbour: a stored
 * key has to be read back to ask whether its decision has since been stored,
 * and a parser living apart from the format it parses is free to drift from
 * it. `listingIdentityKey` round-trips through this for every keyable
 * identity, which is the property that binds the two.
 */
export const parseListingIdentityKey = (
  key: string,
): ListingIdentity | null => {
  if (key.startsWith(IDENTITY_KEY_PREFIX.DOCUMENT)) {
    const sourceDocumentId = key.slice(IDENTITY_KEY_PREFIX.DOCUMENT.length);
    return sourceDocumentId.length === 0
      ? null
      : { type: "document", sourceDocumentId };
  }
  if (!key.startsWith(IDENTITY_KEY_PREFIX.CASE_NUMBER)) {
    return null;
  }
  const rest = key.slice(IDENTITY_KEY_PREFIX.CASE_NUMBER.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }
  return {
    type: "case-number",
    language: rest.slice(0, separator),
    caseNumber: rest.slice(separator + 1),
  };
};

/** One item as the publisher lists it, plus how the ingest would key it. */
export type ReconciliationListingItem = {
  identity: ListingIdentity;
  /** Verbatim listing payload, JSON-serializable; replayed into buildDecision. */
  payload: unknown;
};

export type ReconciliationSlicePage = {
  items: ReconciliationListingItem[];
  /** 0 where the publisher lists nothing for the slice at all. */
  totalPages: number;
};

export type ReconciliationSlicePageOptions = {
  slice: string;
  /** 0-indexed page within the slice. */
  page: number;
  signal?: AbortSignal | undefined;
};

/**
 * What building one listed item produced. `detail-unavailable` must never be
 * written: a detail-less row would make the identity held and take the
 * document out of every later reconciliation.
 */
export type ReconciliationBuildOutcome =
  | { type: "built"; decision: IngestionResult }
  | { type: "unkeyable" }
  | { type: "detail-unavailable" };

/**
 * How a source's history divides into addressable slices.
 *
 * Slices are opaque strings to the loop and must sort lexicographically in
 * walk order, so a ledger's `(source, slice)` rows can be ordered and
 * compared without the loop knowing what a slice means to the adapter.
 *
 * Separated from {@link SourceReconciliation} because it is the half that
 * says nothing about what a slice contains: `reconciliation-plan.ts` selects
 * work off these five fields alone, so any corpus family with a slice-walk —
 * legislation included — feeds the same selector rather than a second copy of
 * its ordering rules.
 */
export type SourceSliceWalk = {
  /**
   * The discriminant against a corpus-family-specific unsupported marker,
   * absent here so an implemented capability is written plainly rather than
   * wrapped. Declared so every reader narrows on one field instead of probing
   * for another.
   */
  type?: undefined;
  /** First slice the publisher can list (e.g. the feed's first day). */
  firstSlice: string;
  /** Slice for a UTC instant (the tip). */
  sliceOf: (now: Date) => string;
  /** Next slice after `slice` in walk order, or null past the tip. */
  nextSlice: (slice: string) => string | null;
  /**
   * Slice before `slice` in walk order, or null at `firstSlice`. The
   * historical sweep runs newest-first, so it needs the walk order reversed:
   * unsurveyed recent history is worth more than unsurveyed old history, and
   * a sweep that could only step forward would have to start at the feed's
   * beginning every time.
   */
  previousSlice: (slice: string) => string | null;
  /** Slices near the tip that get re-walked on a fast cadence. */
  tipWindowDays: number;
};

/**
 * The capability that makes a source reconcilable: the publisher can be asked
 * what it holds for a slice, independently of the cursor the crawl advanced.
 */
export type SourceReconciliation = SourceSliceWalk & {
  /**
   * Whether a stored row counts as held only when it carries the document,
   * and not when it carries the listing metadata alone.
   *
   * Defaults to false, and that default is load-bearing rather than lazy. A
   * source may be metadata-only by design: sk-courts ingests the listing and
   * a separate drain fetches documents afterwards, so at any moment a large
   * part of its corpus legitimately holds no document. Treating those rows as
   * not held would report millions of decisions missing and re-ingest them
   * under reconciliation, which is a worse failure than the one this flag
   * fixes.
   *
   * Set it only where a detail-less row means the document fetch failed for a
   * decision the source otherwise stores whole. There the row is a stub the
   * walk left behind, and reading it as held takes the decision out of every
   * later reconciliation: the identity is present, the slice reads reconciled,
   * and the document is never hunted again.
   *
   * Keyed on the pipeline's own `isListingOnly` marker, so it means the same
   * thing for every source that opts in.
   */
  heldRequiresDetail?: boolean | undefined;
  listSlicePage: (
    options: ReconciliationSlicePageOptions,
  ) => Promise<ReconciliationSlicePage>;
  buildDecision: (
    payload: unknown,
    signal?: AbortSignal,
  ) => Promise<ReconciliationBuildOutcome>;
};

/**
 * What asking a source how much it holds produced.
 *
 * Three answers rather than a nullable number. "The publisher exposes no
 * count" is a permanent property of the source; "the probe did not complete"
 * is a statement about one request and nothing about the source. A caller
 * given only null has to guess which it got, and every caller guessed the
 * same way: it reported both as "no count" and alarmed on neither.
 *
 * `errorTag` is a structural, non-PII identifier — an `errorTag(...)` result
 * where the adapter caught a throw, and an adapter-authored tag naming the
 * step where it did not (a refused status, an unreadable payload). Never a
 * message: these tags reach logs and dashboards.
 */
export type SourceTotalCount =
  | { type: "count"; total: number }
  | { type: "no-count-endpoint" }
  | { type: "probe-failed"; errorTag: string };

/**
 * Tags for the count probe failures an adapter detects without a throw.
 * Alongside `errorTag(...)`, which names the ones it catches.
 */
export const SOURCE_TOTAL_PROBE_FAILURE = {
  /** The count endpoint answered with a status the adapter refuses. */
  HTTP_STATUS: "http-status",
  /** The answer carried no count this adapter can read. */
  UNREADABLE_PAYLOAD: "unreadable-payload",
} as const;

export type SourceTotalProbeFailure =
  (typeof SOURCE_TOTAL_PROBE_FAILURE)[keyof typeof SOURCE_TOTAL_PROBE_FAILURE];

/** A failure the adapter detected without a throw. */
export const sourceTotalProbeFailed = (
  failure: SourceTotalProbeFailure,
): SourceTotalCount => ({ type: "probe-failed", errorTag: failure });

/**
 * The count answer for a number an adapter read out of a publisher's payload.
 *
 * One rule for every source: a total is a positive, finite integer, and
 * anything else is a payload the adapter could not read rather than a corpus
 * of nothing. Zero especially — no publisher here holds no decisions, so a
 * zero is a query that did not run, and recording it would state a false floor
 * that every coverage figure is then measured against.
 */
export const sourceTotalRead = (value: number): SourceTotalCount =>
  Number.isSafeInteger(value) && value > 0
    ? { type: "count", total: value }
    : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD);

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
  /**
   * The jurisdiction this source publishes for. Typed rather than free text:
   * every per-jurisdiction policy in the slice is a total map over
   * `CaseLawJurisdiction`, so registering a source for a jurisdiction nobody
   * has declared a citation-resolution policy for is a compile error rather
   * than a silent default at run time.
   */
  country: CaseLawJurisdiction;
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
   * Ask the source how many decisions it holds, so held-vs-total coverage has
   * a denominator the publisher itself states.
   *
   * Required: a source nobody can count is a source whose coverage nobody can
   * report, and that has to be a stated property of the adapter rather than a
   * field somebody forgot. An adapter classifies its own answer, because only
   * it knows whether its publisher states no total or its probe broke.
   */
  getTotalCount: (signal: AbortSignal) => Promise<SourceTotalCount>;
  /**
   * Ask the publisher what it lists for a slice, so the standing
   * reconciliation loop can compare that against what is held and ingest the
   * difference.
   *
   * Required. Every registered case-law source publishes an independently
   * addressable listing, so unsupported reconciliation is not a valid adapter
   * state.
   */
  reconciliation: SourceReconciliation;
};

/** Preserve an adapter's literal registry key while contextualizing its API. */
export const defineSourceAdapter = <const TKey extends string>(
  adapter: SourceAdapter & { readonly key: TKey },
): SourceAdapter & { readonly key: TKey } => adapter;
