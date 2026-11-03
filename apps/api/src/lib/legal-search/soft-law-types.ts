import { panic, TaggedError } from "better-result";
import type { Result } from "better-result";

import type { GuidanceKind } from "@stll/legal-ast/document-kind";

import type {
  SourceFieldInventory,
  SourceSliceWalk,
  SourceSurfaceCensus,
  SourceTotalCount,
} from "@/api/lib/legal-search/ingestion-types";
import type { PublisherGateId } from "@/api/lib/legal-search/publisher-gates";

import {
  SOFT_LAW_BLOCK_REASONS,
  type SoftLawFetch,
  type SoftLawFetchError,
} from "./soft-law-access-types";

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
export type SoftLawExtractionQuality =
  (typeof SOFT_LAW_EXTRACTION_QUALITIES)[number];
/** Higher ranks represent more useful extracted content and may replace lower ranks. */
export const SOFT_LAW_EXTRACTION_QUALITY_RANK = {
  extraction_failed: 0,
  needs_ocr: 1,
  scanned_ocr: 2,
  text_layer: 3,
  html: 4,
} as const satisfies Record<SoftLawExtractionQuality, number>;
export const isTextlessExtraction = (
  text: string | null,
  extractionQuality: SoftLawExtractionQuality,
) =>
  text === null &&
  SOFT_LAW_EXTRACTION_QUALITY_RANK[extractionQuality] <
    SOFT_LAW_EXTRACTION_QUALITY_RANK.text_layer;
export const SOFT_LAW_STATED_STATES = ["stated", "not_stated"] as const;
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
type SoftLawAuthorityDefinition = {
  domain: "data-protection" | "competition";
  jurisdiction: string;
  name: string;
};

export const SOFT_LAW_AUTHORITIES = {
  "cz-uoou": {
    domain: "data-protection",
    jurisdiction: "CZE",
    name: "Úřad pro ochranu osobních údajů",
  },
  "eu-edpb": {
    domain: "data-protection",
    jurisdiction: "EU",
    name: "European Data Protection Board",
  },
  "eu-wp29": {
    domain: "data-protection",
    jurisdiction: "EU",
    name: "Article 29 Working Party",
  },
  "at-dsb": {
    domain: "data-protection",
    jurisdiction: "AUT",
    name: "Austria DSB",
  },
  "be-apd": {
    domain: "data-protection",
    jurisdiction: "BEL",
    name: "Belgium APD/GBA",
  },
  "bg-cpdp": {
    domain: "data-protection",
    jurisdiction: "BGR",
    name: "Bulgaria CPDP",
  },
  "hr-azop": {
    domain: "data-protection",
    jurisdiction: "HRV",
    name: "Croatia AZOP",
  },
  "cy-dpa": {
    domain: "data-protection",
    jurisdiction: "CYP",
    name: "Cyprus DPA",
  },
  "dk-datatilsynet": {
    domain: "data-protection",
    jurisdiction: "DNK",
    name: "Denmark Datatilsynet",
  },
  "ee-aki": {
    domain: "data-protection",
    jurisdiction: "EST",
    name: "Estonia AKI",
  },
  "fi-ombudsman": {
    domain: "data-protection",
    jurisdiction: "FIN",
    name: "Finland Data Protection Ombudsman",
  },
  "fr-cnil": {
    domain: "data-protection",
    jurisdiction: "FRA",
    name: "France CNIL",
  },
  "de-bfdi": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Germany BfDI",
  },
  "el-hdpa": {
    domain: "data-protection",
    jurisdiction: "GRC",
    name: "Greece HDPA",
  },
  "hu-naih": {
    domain: "data-protection",
    jurisdiction: "HUN",
    name: "Hungary NAIH",
  },
  "is-personuvernd": {
    domain: "data-protection",
    jurisdiction: "ISL",
    name: "Iceland Persónuvernd",
  },
  "ie-dpc": {
    domain: "data-protection",
    jurisdiction: "IRL",
    name: "Ireland DPC",
  },
  "it-garante": {
    domain: "data-protection",
    jurisdiction: "ITA",
    name: "Italy Garante",
  },
  "lv-dvi": {
    domain: "data-protection",
    jurisdiction: "LVA",
    name: "Latvia DVI",
  },
  "li-dss": {
    domain: "data-protection",
    jurisdiction: "LIE",
    name: "Liechtenstein DSS",
  },
  "lt-vdai": {
    domain: "data-protection",
    jurisdiction: "LTU",
    name: "Lithuania VDAI",
  },
  "lu-cnpd": {
    domain: "data-protection",
    jurisdiction: "LUX",
    name: "Luxembourg CNPD",
  },
  "mt-idpc": {
    domain: "data-protection",
    jurisdiction: "MLT",
    name: "Malta IDPC",
  },
  "nl-ap": {
    domain: "data-protection",
    jurisdiction: "NLD",
    name: "Netherlands AP",
  },
  "no-datatilsynet": {
    domain: "data-protection",
    jurisdiction: "NOR",
    name: "Norway Datatilsynet",
  },
  "pl-uodo": {
    domain: "data-protection",
    jurisdiction: "POL",
    name: "Poland UODO",
  },
  "pt-cnpd": {
    domain: "data-protection",
    jurisdiction: "PRT",
    name: "Portugal CNPD",
  },
  "ro-anspdcp": {
    domain: "data-protection",
    jurisdiction: "ROU",
    name: "Romania ANSPDCP",
  },
  "sk-uoou": {
    domain: "data-protection",
    jurisdiction: "SVK",
    name: "Slovakia ÚOOÚ",
  },
  "si-ip": {
    domain: "data-protection",
    jurisdiction: "SVN",
    name: "Slovenia IP",
  },
  "es-aepd": {
    domain: "data-protection",
    jurisdiction: "ESP",
    name: "Spain AEPD",
  },
  "se-imy": {
    domain: "data-protection",
    jurisdiction: "SWE",
    name: "Sweden IMY",
  },
  "eu-edps": { domain: "data-protection", jurisdiction: "EU", name: "EDPS" },
  "de-dsk": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Germany DSK joint publisher",
  },
  "de-bw": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Baden-Württemberg LfDI",
  },
  "de-by-baylfd": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Bavaria BayLfD (public)",
  },
  "de-by-baylda": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Bavaria BayLDA (private)",
  },
  "de-be": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Berlin BlnBDI",
  },
  "de-bb": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Brandenburg LDA",
  },
  "de-hb": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Bremen LfDI",
  },
  "de-hh": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Hamburg HmbBfDI",
  },
  "de-he": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Hesse HBDI",
  },
  "de-mv": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Mecklenburg-Vorpommern LfDI",
  },
  "de-ni": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Lower Saxony LfD",
  },
  "de-nw": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "North Rhine-Westphalia LDI",
  },
  "de-rp": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Rhineland-Palatinate LfDI",
  },
  "de-sl": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Saarland UDZ",
  },
  "de-sn": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Saxony SächsDSB",
  },
  "de-st": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Saxony-Anhalt LfD",
  },
  "de-sh": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Schleswig-Holstein ULD",
  },
  "de-th": {
    domain: "data-protection",
    jurisdiction: "DEU",
    name: "Thuringia TLfDI",
  },
  "es-apdcat": {
    domain: "data-protection",
    jurisdiction: "ESP",
    name: "Catalonia APDCAT",
  },
  "es-avpd": {
    domain: "data-protection",
    jurisdiction: "ESP",
    name: "Basque AVPD",
  },
  "es-ctpd": {
    domain: "data-protection",
    jurisdiction: "ESP",
    name: "Andalusia CTPDA",
  },
  "at-pdk": {
    domain: "data-protection",
    jurisdiction: "AUT",
    name: "Austria PDK",
  },
  "be-vtc": {
    domain: "data-protection",
    jurisdiction: "BEL",
    name: "Flemish VTC",
  },
  "be-coc": {
    domain: "data-protection",
    jurisdiction: "BEL",
    name: "Belgian COC",
  },
  "be-comitei": {
    domain: "data-protection",
    jurisdiction: "BEL",
    name: "Belgian Permanent R",
  },
  "be-comitep": {
    domain: "data-protection",
    jurisdiction: "BEL",
    name: "Belgian Permanent P",
  },
} as const satisfies Record<string, SoftLawAuthorityDefinition>;
export type SoftLawAuthority = keyof typeof SOFT_LAW_AUTHORITIES;
export type SoftLawStated<T> =
  { state: "stated"; value: T } | { state: "not_stated" };
export type SoftLawEvidence = {
  url: string;
  quote: string;
  locator: string;
};
export type SoftLawExpression =
  | { type: "unspecified" }
  | {
      type: "identified";
      language: string;
      revision: SoftLawStated<string>;
    };
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
  kind: GuidanceKind;
  /** Publisher's original type label; absent only in historical CZ records. */
  sourceKind?: string;
  /** Stable publisher record id, distinct from a human citation or mutable locator. */
  sourceDocumentId?: string;
  statedReference: SoftLawStated<string>;
  issuedOn: SoftLawStated<string>;
  /** Historical CZ rows and retry receipts predate these publisher fields. Authorities requiring identified expressions supply all three. */
  expression?: SoftLawExpression;
  stage?: SoftLawStage;
  relations?: readonly SoftLawRelation[];
  validity: {
    state: (typeof SOFT_LAW_VALIDITY_STATES)[number];
    basis: (typeof SOFT_LAW_VALIDITY_BASES)[number];
  };
};
export type SoftLawRawProvenance = {
  url: string;
  retrievedAt: string;
  sha256: string;
};
export type SoftLawEntry = {
  type: "document";
  url: string;
  /** Publisher index/detail responses retained alongside the document bytes. */
  sourcePages?: readonly string[];
  /** Exact discovery responses survive a durable retry; base64 preserves their bytes in JSONB. */
  sourceRaw?: readonly {
    role: string;
    contentBase64: string;
    contentType: string;
    /** Older persisted envelopes predate per-response provenance. */
    provenance?: SoftLawRawProvenance;
  }[];
  metadata: SoftLawMetadata;
  sourceDates: Readonly<Record<string, string>>;
};
export type SoftLawRejectedEntry = {
  type: "rejected";
  url: string;
  /** Exact discovery responses retained so the rejection can be audited. */
  sourceRaw?: readonly {
    role: string;
    contentBase64: string;
    contentType: string;
  }[];
  rejection: {
    tag: Exclude<(typeof SOFT_LAW_ITEM_TAGS)[number], "identity_collision">;
    reason: string;
  };
};
export type SoftLawDiscoveryEntry = SoftLawEntry | SoftLawRejectedEntry;

/**
 * A retry receipt as stored. Workers released before the entry discriminator
 * wrote document entries without `type`, and one may still do so while a
 * deployment rolls out after the receipt migration ran. Remove this branch and
 * `storedSoftLawDiscoveryEntry` in the release after the one carrying it, once
 * no such worker can run.
 */
export type StoredSoftLawDiscoveryEntry =
  SoftLawDiscoveryEntry | (Omit<SoftLawEntry, "type"> & { type?: undefined });

export const storedSoftLawDiscoveryEntry = (
  entry: StoredSoftLawDiscoveryEntry,
): SoftLawDiscoveryEntry => {
  switch (entry.type) {
    case "document":
    case "rejected":
      return entry;
    case undefined:
      return {
        type: "document",
        url: entry.url,
        ...(entry.sourcePages === undefined
          ? {}
          : { sourcePages: entry.sourcePages }),
        ...(entry.sourceRaw === undefined
          ? {}
          : { sourceRaw: entry.sourceRaw }),
        metadata: entry.metadata,
        sourceDates: entry.sourceDates,
      };
    default:
      entry satisfies never;
      return panic("Unhandled stored soft-law entry type");
  }
};
export type SoftLawDocumentInput = {
  metadata: SoftLawMetadata;
  raw: readonly {
    role: string;
    bytes: Uint8Array;
    contentType: string;
    /** Older persisted envelopes predate per-response provenance. */
    provenance?: SoftLawRawProvenance;
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
export type SoftLawAdapterConfiguration =
  { type: "default" } | { type: "admission-file"; path: string };
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
        entries: readonly SoftLawDiscoveryEntry[];
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
type SoftLawItemErrorRejectionOptions = {
  error: unknown;
  url: string;
  sourceRaw: NonNullable<SoftLawRejectedEntry["sourceRaw"]>;
};
export const softLawItemErrorRejection = ({
  error,
  url,
  sourceRaw,
}: SoftLawItemErrorRejectionOptions): SoftLawRejectedEntry | null =>
  SoftLawItemError.is(error)
    ? {
        type: "rejected",
        url,
        rejection: { tag: error.tag, reason: error.message },
        sourceRaw,
      }
    : null;
export class SoftLawListingIncompleteError extends TaggedError(
  "SoftLawListingIncompleteError",
)<{ message: string }> {}
