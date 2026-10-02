import { TaggedError } from "better-result";
import type { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
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

export const SOFT_LAW_KINDS = [
  "methodology",
  "recommendation",
  "opinion",
  "faq",
  "guideline",
  "position",
  "inspection_report",
  "annual_report",
  "other",
] as const;
export const SOFT_LAW_LISTING_STATES = ["listed", "no_longer_listed"] as const;
export const SOFT_LAW_LOCATOR_STATES = ["current", "historical"] as const;
export const SOFT_LAW_BATCH_LIMIT = 100;
export const SOFT_LAW_VALIDITY_STATES = [
  "not_stated",
  "withdrawn",
  "superseded",
  "historical_repealed_basis",
] as const;
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
export const SOFT_LAW_STATED_STATES = ["stated", "not_stated"] as const;
export const SOFT_LAW_RUN_STATES = [
  "idle",
  "running",
  "deciding",
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
  "edpb_translation",
  "third_party_publication",
] as const;
export const SOFT_LAW_ATTEMPT_STATES = [
  "applied",
  "unchanged",
  "rejected",
  "retryable",
  "deferred",
] as const;
export const SOFT_LAW_AUTHORITIES = {
  "cz-uoou": { jurisdiction: "CZE", name: "Úřad pro ochranu osobních údajů" },
} as const;
export type SoftLawAuthority = keyof typeof SOFT_LAW_AUTHORITIES;
export type SoftLawStated<T> =
  | { state: "stated"; value: T }
  | { state: "not_stated" };
export type SoftLawMetadata = {
  title: string;
  kind: (typeof SOFT_LAW_KINDS)[number];
  statedReference: SoftLawStated<string>;
  issuedOn: SoftLawStated<string>;
  validity: {
    state: (typeof SOFT_LAW_VALIDITY_STATES)[number];
    basis: (typeof SOFT_LAW_VALIDITY_BASES)[number];
  };
};
export type SoftLawEntry = {
  url: string;
  metadata: SoftLawMetadata | null;
  sourceDates: Readonly<Record<string, string>>;
  /** Present only when the listing publishes a revision suitable for caching. */
  cacheKey?: string;
};
export type SoftLawDocumentInput = {
  type: "document";
  metadata: SoftLawMetadata;
  raw: readonly { role: string; bytes: Uint8Array; contentType: string }[];
  text: string | null;
  extractionQuality: (typeof SOFT_LAW_EXTRACTION_QUALITIES)[number];
  sourceDates: Readonly<Record<string, string>>;
};
export type SoftLawDeferredObservation = {
  entry: SoftLawEntry;
  input: Omit<SoftLawDocumentInput, "raw">;
  documentId: SafeId<"softLawDocument">;
  identityKey: string;
  contentHash: string;
  rawObjects: { role: string; key: string; contentType: string }[];
};
export type SoftLawDocumentFetchResult =
  | SoftLawDocumentInput
  | {
      type: "excluded";
      reason: "edpb_translation" | "third_party_publication";
    };
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
      SoftLawIngestionError | SoftLawFetchError
    >
  >;
  fetchDocument: (
    entry: SoftLawEntry,
    context: { signal: AbortSignal; fetch: SoftLawFetch; maxRawBytes: number },
  ) => Promise<
    Result<
      SoftLawDocumentFetchResult,
      | SoftLawIngestionError
      | SoftLawItemError
      | SoftLawFetchError
      | SoftLawPageBudgetError
    >
  >;
  getTotalCount: (context: {
    signal: AbortSignal;
    fetch: SoftLawFetch;
  }) => Promise<
    Result<SourceTotalCount, SoftLawIngestionError | SoftLawFetchError>
  >;
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

export class SoftLawPageBudgetError extends TaggedError(
  "SoftLawPageBudgetError",
)<{
  message: string;
}> {}
