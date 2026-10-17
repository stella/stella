import { TaggedError } from "better-result";
import type { Result } from "better-result";

// Pure document vocabulary lives in legal-ast so packages never depend on the API.
// This module remains the ingestion contract owner and reexports that vocabulary.
import type {
  SOFT_LAW_KINDS,
  SOFT_LAW_VALIDITY_STATES,
  SoftLawAuthority,
  SoftLawStated,
  SoftLawEvidence,
  SoftLawExpression,
} from "@stll/legal-ast/soft-law";

import type {
  SourceFieldInventory,
  SourceSurfaceCensus,
  SourceTotalCount,
  SourceSliceWalk,
} from "@/api/lib/legal-search/ingestion-types";
import type { PublisherGateId } from "@/api/lib/legal-search/publisher-gates";

import {
  type SoftLawFetchError,
  SOFT_LAW_BLOCK_REASONS,
  type SoftLawFetch,
} from "./soft-law-access-types";

export {
  SOFT_LAW_KINDS,
  SOFT_LAW_VALIDITY_STATES,
  SOFT_LAW_STATED_STATES,
  SOFT_LAW_AUTHORITIES,
  type SoftLawAuthority,
  type SoftLawKind,
  type SoftLawValidityState,
  type SoftLawStated,
  type SoftLawEvidence,
  type SoftLawExpression,
} from "@stll/legal-ast/soft-law";

export const SOFT_LAW_LISTING_STATES = ["listed", "no_longer_listed"] as const;
export const SOFT_LAW_LOCATOR_STATES = ["current", "historical"] as const;
export const SOFT_LAW_BATCH_LIMIT = 100;
export const SOFT_LAW_RAW_BYTE_LIMIT = 64 * 1024 * 1024;
export const SOFT_LAW_RAW_PART_LIMIT = 20;
export const SOFT_LAW_VALIDITY_BASES = [
  "source_stated",
  "archived_source_stated",
] as const;
export const SOFT_LAW_EXTRACTION_QUALITIES = [
  "html",
  "text_layer",
  "needs_ocr",
  "scanned_ocr",
  "extraction_failed",
] as const;
export const SOFT_LAW_RUN_STATES = [
  "idle",
  "running",
  "blocked",
  "failed",
  "listing_incomplete",
] as const;
export const SOFT_LAW_FAILURE_TAGS = [
  ...SOFT_LAW_BLOCK_REASONS,
  "ingestion_failed",
  "listing_incomplete",
  "deferred_window",
] as const;
export const SOFT_LAW_ITEM_TAGS = [
  "identity_collision",
  "ambiguous_locator",
  "invalid_document",
  "retry_exhausted",
] as const;
export const SOFT_LAW_ATTEMPT_STATES = [
  "applied",
  "unchanged",
  "rejected",
  "retryable",
] as const;
export type SoftLawStage =
  | { state: "not_stated" }
  | { state: "consultation" | "adopted"; evidence: SoftLawEvidence };
export type SoftLawRelation = {
  type: "supersedes" | "superseded_by" | "endorses";
  reference: string;
  evidence: SoftLawEvidence;
};
export type SoftLawMetadata = {
  title: string;
  kind: (typeof SOFT_LAW_KINDS)[number];
  /** Publisher's original type label; absent only in historical CZ records. */
  sourceKind?: string;
  /** Stable publisher record id, distinct from a human citation or mutable locator. */
  sourceDocumentId?: string;
  statedReference: SoftLawStated<string>;
  issuedOn: SoftLawStated<string>;
  /** Historical CZ rows and retry receipts predate these publisher fields. EU adapters must provide all three. */
  expression?: SoftLawExpression;
  stage?: SoftLawStage;
  relations?: readonly SoftLawRelation[];
  validity: {
    state: (typeof SOFT_LAW_VALIDITY_STATES)[number];
    basis: (typeof SOFT_LAW_VALIDITY_BASES)[number];
  };
};
export type SoftLawEntry = {
  url: string;
  /** Publisher index/detail responses retained alongside the document bytes. */
  sourcePages?: readonly string[];
  /** Exact discovery responses survive a durable retry; base64 preserves their bytes in JSONB. */
  sourceRaw?: readonly {
    role: string;
    contentBase64: string;
    contentType: string;
  }[];
  metadata: SoftLawMetadata;
  sourceDates: Readonly<Record<string, string>>;
};
export type SoftLawDocumentInput = {
  metadata: SoftLawMetadata;
  raw: readonly {
    role: string;
    bytes: Uint8Array;
    contentType: string;
    /** Historical CZ envelopes predate this distinction. */
    purpose?: "document" | "discovery";
  }[];
  sourceDates: Readonly<Record<string, string>>;
} & (
  | {
      extractionQuality: "extraction_failed";
      text: null;
      extractionFailure: string;
    }
  | {
      extractionQuality: Exclude<
        (typeof SOFT_LAW_EXTRACTION_QUALITIES)[number],
        "extraction_failed"
      >;
      text: string | null;
      extractionFailure?: never;
    }
);
export type SoftLawAccessPolicy = {
  publisherGate: PublisherGateId;
  userAgent: `Stella/${string} (+https://${string})`;
  window:
    | { type: "any_time" }
    | {
        type: "off_peak";
        timeZone: string;
        startHour: number;
        endHour: number;
      };
};
export type SoftLawRawObject = Omit<
  SoftLawDocumentInput["raw"][number],
  "bytes"
> & {
  key: string;
};
export type SoftLawSourceAdapter = {
  key: string;
  authority: SoftLawAuthority;
  access: SoftLawAccessPolicy;
  discover: (options: {
    cursor: string | null;
    signal: AbortSignal;
    fetch: SoftLawFetch;
  }) => Promise<
    Result<
      {
        entries: readonly SoftLawEntry[];
        nextCursor: string | null;
      },
      SoftLawIngestionError | SoftLawItemError | SoftLawFetchError
    >
  >;
  fetchDocument: (
    entry: SoftLawEntry,
    context: { signal: AbortSignal; fetch: SoftLawFetch },
  ) => Promise<
    Result<
      SoftLawDocumentInput,
      SoftLawIngestionError | SoftLawItemError | SoftLawFetchError
    >
  >;
  getTotalCount: (context: {
    signal: AbortSignal;
    fetch: SoftLawFetch;
  }) => Promise<SourceTotalCount>;
  sliceWalk: SourceSliceWalk | { type: "unsupported"; reason: string };
  sourceFields: SourceFieldInventory;
  sourceSurfaces: SourceSurfaceCensus;
};

export class SoftLawIngestionError extends TaggedError(
  "SoftLawIngestionError",
)<{ message: string; cause?: unknown }> {}
export class SoftLawItemError extends TaggedError("SoftLawItemError")<{
  message: string;
  tag: Exclude<(typeof SOFT_LAW_ITEM_TAGS)[number], "identity_collision">;
}> {}
export class SoftLawListingIncompleteError extends TaggedError(
  "SoftLawListingIncompleteError",
)<{ message: string }> {}
