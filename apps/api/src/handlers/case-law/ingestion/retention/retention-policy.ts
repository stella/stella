/**
 * How the pipeline checks that a parsed decision kept the publisher's text.
 *
 * The check compares a decision's blocks against text taken from what the
 * publisher served, its stored `sourceRaw`, never against anything the
 * parser produced. A parser that validated itself could only report loss
 * after the point it chose to compare from: text dropped while selecting
 * the body, decoding a field or splitting paragraphs would be invisible,
 * because the comparison text had already lost it too.
 *
 * So every source declares its projection here, one per source, and the
 * pipeline runs the oracle once for every decision a parser built. A
 * projection reads `sourceRaw` alone; the `retention-source-independence`
 * lint rule keeps parser modules and AST builders out of the projection
 * modules, which is what makes the two implementations independent.
 */
import type {
  validateAst,
  ValidationSource,
} from "@/api/lib/legal-search/parsers/validate-ast";

/**
 * The oracle's tolerances and source handling, as the projection states
 * them. The source policy is not among them: it is how the oracle reads a
 * source on both sides, shared with the parser, so the registry
 * (`retention-sources.ts`) supplies it and projections stay independent of
 * it.
 */
export type RetentionCheckOptions = Pick<
  NonNullable<Parameters<typeof validateAst>[2]>,
  | "hyphenatedLineBreaks"
  | "maxMissingWords"
  | "minRetainedPct"
  | "wordComparisonText"
>;

/**
 * Why one stored record carries no publisher text to compare against. A
 * projection answers per record: one source can serve full text for some
 * decisions and metadata alone for others.
 */
export const RETENTION_TEXT_ABSENCE = {
  /** The publisher served the record without any decision text. */
  NOT_PUBLISHED: "not-published",
  /** The text lives in a document the pipeline stores apart (a PDF). */
  SEPARATE_DOCUMENT: "separate-document",
  /**
   * The publisher's file is larger than a projection reads within its budget
   * (`PDF_PROJECTION_MAX_BYTES`). Extracting it would hold the process for
   * seconds, so the decision is stored unchecked and the skip is logged.
   */
  OVER_CHECK_BUDGET: "over-check-budget",
} as const;

export type RetentionTextAbsence =
  (typeof RETENTION_TEXT_ABSENCE)[keyof typeof RETENTION_TEXT_ABSENCE];

/** Why a source's stored raw cannot be read as the projection expects. */
export const RETENTION_PROJECTION_FAILURE = {
  /** The isolated projection could not complete; not a verdict on the file. */
  WORKER_FAILED: "projection-worker-failed",
  /** The stored raw is not the envelope the source writes (bad JSON, say). */
  UNREADABLE_ENVELOPE: "unreadable-envelope",
  /** The envelope parses but lacks the part that holds the decision text. */
  MISSING_TEXT_PART: "missing-text-part",
  /**
   * The text part holds a publisher file (a Word package, an RTF) that does
   * not open as that format, so no text can be read from it.
   */
  UNREADABLE_DOCUMENT: "unreadable-document",
} as const;

export type RetentionProjectionFailure =
  (typeof RETENTION_PROJECTION_FAILURE)[keyof typeof RETENTION_PROJECTION_FAILURE];

/**
 * What a projection read from one stored raw. An unreadable raw is an
 * outcome rather than an error: the check is telemetry, and the decision is
 * stored either way, so the pipeline reports the declared reason and moves on.
 */
export type RetentionProjection =
  | {
      readonly type: "source";
      readonly source: ValidationSource;
      readonly options?: RetentionCheckOptions | undefined;
    }
  | { readonly type: "no-text"; readonly reason: RetentionTextAbsence }
  | {
      readonly type: "unreadable";
      readonly reason: RetentionProjectionFailure;
    };

/**
 * Why a source builds no parsed document at all, so no decision of it is
 * ever checked.
 */
export const RETENTION_UNPARSED_REASON = {
  /** The source stores listing metadata; a separate drain fetches documents. */
  METADATA_ONLY: "metadata-only",
  /** A seeded source no adapter or importer declares. */
  UNREGISTERED_SOURCE: "unregistered-source",
} as const;

export type RetentionUnparsedReason =
  (typeof RETENTION_UNPARSED_REASON)[keyof typeof RETENTION_UNPARSED_REASON];

export type RetentionPolicy =
  | {
      readonly type: "checked";
      /**
       * Asynchronous because some stored raws hold a publisher file (a PDF
       * inside the envelope) whose text only an asynchronous reader can
       * extract.
       */
      readonly project: (sourceRaw: string) => Promise<RetentionProjection>;
    }
  | { readonly type: "unparsed"; readonly reason: RetentionUnparsedReason };
