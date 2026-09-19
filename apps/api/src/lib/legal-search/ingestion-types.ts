import { panic, Result } from "better-result";

import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type {
  DecisionTextFieldKey,
  ReadDecisionTextFields,
} from "@stll/api-contract/case-law-text-field";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";

import type { DocumentAst } from "@/api/lib/case-law/document-ast";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

export { EMPTY_AST };
export type { EmptyAst };

/** A judge as one decision names them, before the roster is consulted. */
export type DecisionJudgeInput = {
  role: DecisionJudgeRole;
  nameAsPrinted: string;
};

/** Mirrors the publisher-identity columns in the case-law schema. */
export const SOURCE_DOCUMENT_ID_MAX_LENGTH = 256;

export const isPersistableSourceDocumentId = (value: string): boolean =>
  value.length > 0 && value.length <= SOURCE_DOCUMENT_ID_MAX_LENGTH;

/**
 * How an observation stands to the decision's document.
 *
 * `inline`: the adapter fetched what the publisher serves for this decision,
 * so a result with no text is a decision with no document. `deferred`: the
 * document is fetched later by a queue of its own, and a result with no text
 * says nothing about whether one exists.
 */
export const DOCUMENT_DELIVERY = {
  DEFERRED: "deferred",
  INLINE: "inline",
} as const;

export type DocumentDelivery =
  (typeof DOCUMENT_DELIVERY)[keyof typeof DOCUMENT_DELIVERY];

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
   * Absent means `inline`. An inline result that carries no document is
   * stored unpublished, exactly as a listing-only one is, and is repaired the
   * same way; a deferred one stays public while its queue fetches the text.
   */
  documentDelivery?: DocumentDelivery | undefined;
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
  /**
   * The judges the source names on this decision, in the order it prints
   * them. Absent, not empty, for a source whose pages state none: an empty
   * list is a publisher saying there are none, and the pipeline replaces the
   * decision's stored judges only when an observation carries the field.
   */
  judges?: readonly DecisionJudgeInput[] | undefined;
  /** Publisher text stored under its existing metadata keys by the pipeline. */
  textFields: ReadDecisionTextFields;
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
  /**
   * Binary raw source (e.g. PDF bytes) for S3 upload.
   *
   * The pipeline stores these bytes *instead of* `sourceRaw`, so an adapter
   * that sets both keeps only the bytes and loses the payload that named the
   * decision.
   */
  sourceRawBytes?: Uint8Array | undefined;
  /**
   * Binary responses the envelope names rather than holds, under the part
   * name each has in {@link SourceRawParts}.
   *
   * The envelope is text, so a document the publisher serves as a file has
   * to live beside it. The pipeline writes each of these under the
   * decision's raw prefix and rewrites the envelope's `objects` map with the
   * address it wrote them at; the adapter states only the bytes.
   */
  sourceRawObjects?:
    | Readonly<Record<string, SourceRawObjectPayload>>
    | undefined;
  /** MIME type of sourceRaw/sourceRawBytes for S3 storage. */
  sourceRawContentType?: string | undefined;
};

/** One binary response, as the adapter that fetched it hands it over. */
type SourceRawObjectPayload = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
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
  /**
   * The listing request whose response these decisions were read from.
   *
   * Only the adapter knows which of its requests that was: a session
   * bootstrap, a search POST, and a per-decision detail fetch are all
   * indistinguishable from outside, so request order cannot name it. Set it
   * where the listing response is parsed, and leave it unset on a page that
   * read no listing (a skipped or empty page). `update-fixtures.ts` cites it
   * as the recorded provenance of a page fixture and refuses to record an
   * adapter that names nothing.
   */
  sourceUrl?: string | undefined;
};

/**
 * Every response an adapter fetched for one decision, under the name it gives
 * each part.
 *
 * A source that serves a decision across several pages — a detail page beside
 * the document itself — has to store all of them or replay can only ever
 * recover what the parser already read. A field first captured later is then
 * unrecoverable for stored rows: the page that states it was fetched, parsed
 * for the fields of the day, and dropped.
 *
 * Parts are named by role rather than by URL: a replay asks for the detail
 * page, and which address served it is history.
 */
export type SourceRawParts = Readonly<Record<string, string>>;

/**
 * A binary response the envelope names instead of holding.
 *
 * `location` is an address in the form the corpus key columns already use
 * (`corpus-location.ts`): today always a plain object key, and a packed
 * address once these files are packed together, which is a change to where
 * the bytes are written and to nothing that reads this reference.
 *
 * `sha256` and `byteLength` are over the publisher's bytes, so a read can be
 * checked against what was stored rather than trusted for having arrived —
 * the check that matters once an address names a range inside an object
 * shared with other decisions.
 */
export type SourceRawObjectRef = {
  readonly location: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly byteLength: number;
};

/** The binary responses of one envelope, under their part names. */
export type SourceRawObjects = Readonly<Record<string, SourceRawObjectRef>>;

/**
 * Media type for a multi-part raw payload, distinct from `application/json` so
 * a reader can tell an envelope from a publisher's own JSON document.
 */
export const SOURCE_RAW_ENVELOPE_CONTENT_TYPE =
  "application/vnd.stella.case-law-raw+json";

const SOURCE_RAW_ENVELOPE_VERSION = 1;

/**
 * Write an envelope over the text parts, and over the binary parts it names.
 *
 * `objects` is omitted rather than written empty when a decision has no
 * binary response, so the payload of an adapter that stores only text is
 * byte-identical to what it wrote before binaries existed.
 */
export const encodeSourceRawEnvelope = (
  parts: SourceRawParts,
  objects: SourceRawObjects = {},
): string =>
  JSON.stringify({
    version: SOURCE_RAW_ENVELOPE_VERSION,
    parts,
    ...(Object.keys(objects).length === 0 ? {} : { objects }),
  });

/**
 * The parts of a stored envelope, or `null` for a payload that is not one —
 * which is how a row stored before its adapter had an envelope reads, and why
 * every caller has to handle it rather than assume the shape it writes today.
 */
export const decodeSourceRawEnvelope = (raw: string): SourceRawParts | null => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== SOURCE_RAW_ENVELOPE_VERSION ||
    !("parts" in parsed) ||
    typeof parsed.parts !== "object" ||
    parsed.parts === null
  ) {
    return null;
  }

  const parts = Object.entries(parsed.parts);
  return parts.every(([, value]) => typeof value === "string")
    ? Object.fromEntries(parts.map(([name, value]) => [name, String(value)]))
    : null;
};

const isSourceRawObjectRef = (value: unknown): value is SourceRawObjectRef =>
  typeof value === "object" &&
  value !== null &&
  "location" in value &&
  typeof value.location === "string" &&
  "sha256" in value &&
  typeof value.sha256 === "string" &&
  "contentType" in value &&
  typeof value.contentType === "string" &&
  "byteLength" in value &&
  typeof value.byteLength === "number";

/**
 * The binary parts a stored envelope names, or `{}` for one that names none.
 *
 * Empty rather than null for every absence there is — not an envelope, an
 * envelope written before binaries, an `objects` map that does not read back
 * as references — because all of them mean the same thing to a caller: this
 * row states no binary response. A reader that had to tell them apart would
 * be deciding about the storage format rather than about the decision.
 */
export const decodeSourceRawEnvelopeObjects = (
  raw: string,
): SourceRawObjects => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== SOURCE_RAW_ENVELOPE_VERSION ||
    !("objects" in parsed) ||
    typeof parsed.objects !== "object" ||
    parsed.objects === null
  ) {
    return {};
  }

  const objects = Object.entries(parsed.objects);
  return objects.every(([, value]) => isSourceRawObjectRef(value))
    ? Object.fromEntries(objects)
    : {};
};

/**
 * Re-write a stored envelope with the addresses its binary parts were
 * written under.
 *
 * The adapter cannot name them: an address carries the corpus key the bytes
 * landed at, and the write happens in the pipeline. So the adapter states the
 * bytes and this closes the envelope over what storage answered.
 */
export const withSourceRawObjects = (
  raw: string,
  objects: SourceRawObjects,
): string => {
  const parts = decodeSourceRawEnvelope(raw);
  return parts === null ? raw : encodeSourceRawEnvelope(parts, objects);
};

/**
 * A stored raw payload that is not an envelope, and the part names its own
 * keys stand for.
 *
 * `wrapper-json` is an adapter's own object around several responses,
 * `bare-payload` is one response stored alone, and `document-bytes` is a
 * payload kept as bytes. All three predate the envelope and none is written
 * again once its adapter migrates, which is why this is a ledger rather than a
 * shape the encoder can produce.
 */
export type LegacyRawShape =
  | {
      readonly shape: "wrapper-json";
      readonly contentTypes: readonly (string | null)[];
      /** Wrapper key to the part name the envelope would give that response. */
      readonly keys: Readonly<Record<string, string>>;
    }
  | {
      readonly shape: "bare-payload" | "document-bytes";
      readonly contentTypes: readonly (string | null)[];
      readonly part: string;
    };

/**
 * Austria's eleven tribunals and the ministry's document service each stored
 * the two responses they read in one object of their own, so one shape
 * describes twelve adapters and each still deletes its own line.
 *
 * The keys are what those rows hold; the values are the parts the envelope
 * gives the same two responses today, which is what lets a reader of an old
 * row ask for `document-xml` and be answered.
 */
const AT_LISTING_AND_DOCUMENT_JSON = [
  {
    shape: "wrapper-json",
    contentTypes: ["application/json"],
    keys: { listing: "listing", documentXml: "document-xml" },
  },
] as const satisfies readonly LegacyRawShape[];

const LEGACY_RAW_SHAPE_ADAPTERS = [
  ADAPTER_KEYS.CZ_US,
  ADAPTER_KEYS.CZ_REGIONAL,
  ADAPTER_KEYS.SK_COURTS,
  ADAPTER_KEYS.SK_US,
  ADAPTER_KEYS.PL_COURTS,
  ADAPTER_KEYS.EU_ECJ,
  ADAPTER_KEYS.AT_COURTS,
  ADAPTER_KEYS.AT_VFGH,
  ADAPTER_KEYS.AT_VWGH,
  ADAPTER_KEYS.AT_BVWG,
  ADAPTER_KEYS.AT_LVWG,
  ADAPTER_KEYS.AT_ASYLGH,
  ADAPTER_KEYS.AT_UBAS,
  ADAPTER_KEYS.AT_UVS,
  ADAPTER_KEYS.AT_VERG,
  ADAPTER_KEYS.AT_UMSE,
  ADAPTER_KEYS.AT_BKS,
  ADAPTER_KEYS.AT_FINDOK,
] as const satisfies readonly AdapterKey[];

export type LegacyRawShapeAdapter = (typeof LEGACY_RAW_SHAPE_ADAPTERS)[number];

/**
 * The adapters whose stored rows are not envelopes, and what a reader of those
 * rows must accept.
 *
 * Total over the adapters that have such rows and over nothing else: a
 * migrated adapter deletes its line, so the map's length is how much of the
 * fleet still stores a shape only its own reader understands. The conformance
 * suite reads committed fixtures through this map, so a line that stops
 * describing the rows it claims to describe fails rather than rots.
 */
export const LEGACY_RAW_SHAPES = {
  [ADAPTER_KEYS.CZ_US]: [
    {
      shape: "wrapper-json",
      contentTypes: ["application/json"],
      keys: {
        textHtml: "document",
        listingHtml: "listing",
        abstractHtml: "abstract",
      },
    },
    {
      shape: "bare-payload",
      contentTypes: ["text/html", null],
      part: "document",
    },
  ],
  // Kept after the adapter moved to the envelope: every row stored before it
  // did holds the document payload alone, and the listing row that named it
  // was never kept, so those rows are readable only through this shape.
  [ADAPTER_KEYS.CZ_REGIONAL]: [
    {
      shape: "bare-payload",
      contentTypes: ["application/json"],
      part: "document",
    },
  ],
  [ADAPTER_KEYS.SK_COURTS]: [
    {
      shape: "wrapper-json",
      contentTypes: ["application/json"],
      keys: { listItem: "listing", detail: "detail" },
    },
  ],
  [ADAPTER_KEYS.SK_US]: [
    {
      shape: "bare-payload",
      contentTypes: ["application/json"],
      part: "listing",
    },
    {
      // The document file, which the envelope now names as an object
      // beside the parts rather than storing as the payload itself.
      shape: "document-bytes",
      contentTypes: ["application/pdf"],
      part: "document-file",
    },
  ],
  [ADAPTER_KEYS.PL_COURTS]: [
    {
      shape: "wrapper-json",
      contentTypes: ["application/json"],
      keys: { dumpItem: "listing", detail: "detail" },
    },
  ],
  [ADAPTER_KEYS.EU_ECJ]: [
    {
      shape: "bare-payload",
      contentTypes: [
        "application/xhtml+xml",
        "application/xhtml+xml; stella-storage=verbatim",
      ],
      part: "document",
    },
  ],
  [ADAPTER_KEYS.AT_COURTS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_VFGH]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_VWGH]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_BVWG]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_LVWG]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_ASYLGH]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_UBAS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_UVS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_VERG]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_UMSE]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_BKS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_FINDOK]: AT_LISTING_AND_DOCUMENT_JSON,
} as const satisfies Record<LegacyRawShapeAdapter, readonly LegacyRawShape[]>;

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
      identity satisfies never;
      return panic(`Unhandled listing identity: ${JSON.stringify(identity)}`);
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
 * Where a field the publisher states ends up once the decision is stored.
 *
 * A union rather than a string, because the destinations are read back
 * differently: ordinary metadata and decision text have separate boundaries,
 * a result field is a column of the row, and the last two are not fields at all.
 */
export type SourceFieldTarget =
  /** `metadata[key]` on the stored row. */
  | { readonly type: "metadata"; readonly key: string }
  /** A publisher-authored field represented by the decision text contract. */
  | { readonly type: "textField"; readonly key: DecisionTextFieldKey }
  /** A field of the ingestion result itself, spelled as the contract does. */
  | { readonly type: "result"; readonly key: keyof IngestionResult }
  /** Reaches the row inside the parsed document: AST, sections or fulltext. */
  | { readonly type: "document" }
  /** Keys the row: the publisher id the decision is stored under. */
  | { readonly type: "identity" };

/**
 * Marks a reason that went through {@link excludedSourceField}. The symbol is
 * not exported, so an exclusion written as a bare object literal does not
 * satisfy the union: the only way to state one is through the constructor,
 * which is where a blank reason is rejected.
 */
const STATED_REASON: unique symbol = Symbol("stated exclusion reason");

type Whitespace = " " | "\t" | "\n" | "\r";

type Trimmed<TText extends string> = TText extends `${Whitespace}${infer TRest}`
  ? Trimmed<TRest>
  : TText extends `${infer TRest}${Whitespace}`
    ? Trimmed<TRest>
    : TText;

/** A reason with words in it, or `never`, which fails at the call site. */
type StatedReason<TText extends string> =
  Trimmed<TText> extends "" ? never : TText;

/**
 * What an adapter does with one field its source states.
 *
 * Exclusion carries a reason because that is the whole point: a field nobody
 * decided about and a field deliberately left is the same silence otherwise,
 * and the first is how a published headnote sits unread on a page the adapter
 * already fetches. A blank reason would be that same silence wearing the
 * shape of a decision, so it cannot be written.
 */
export type SourceFieldDisposition =
  | { readonly disposition: "stored"; readonly target: SourceFieldTarget }
  | {
      readonly disposition: "excluded";
      readonly reason: string;
      readonly [STATED_REASON]: true;
    };

/**
 * State why a field the source publishes is not stored. The reason has to say
 * something: `""` and `"   "` are compile errors rather than a check somebody
 * has to remember to run.
 */
export const excludedSourceField = <const TText extends string>(
  reason: StatedReason<TText>,
): SourceFieldDisposition => ({
  disposition: "excluded",
  reason,
  [STATED_REASON]: true,
});

/**
 * The adapters that may still declare a surface they do not record.
 *
 * Closed and hand-listed rather than derived from {@link ADAPTER_KEYS}: a
 * source added tomorrow must record what its publisher serves or say why not,
 * and deriving the union would hand it the exemption the day it registers.
 * `source-surface-backlog-baseline.json` names the surfaces each of these may
 * leave unrecorded, and both only shrink.
 */
export const LEGACY_BACKLOG_ADAPTERS = [
  ADAPTER_KEYS.CZ_NS,
  ADAPTER_KEYS.CZ_NSS,
  ADAPTER_KEYS.SK_COURTS,
  ADAPTER_KEYS.SK_US,
  ADAPTER_KEYS.PL_COURTS,
  ADAPTER_KEYS.AT_COURTS,
  ADAPTER_KEYS.AT_VFGH,
  ADAPTER_KEYS.AT_VWGH,
  ADAPTER_KEYS.AT_BVWG,
  ADAPTER_KEYS.AT_LVWG,
  ADAPTER_KEYS.AT_ASYLGH,
  ADAPTER_KEYS.AT_UBAS,
  ADAPTER_KEYS.AT_UVS,
  ADAPTER_KEYS.AT_VERG,
  ADAPTER_KEYS.AT_UMSE,
  ADAPTER_KEYS.AT_BKS,
  ADAPTER_KEYS.EU_ECJ,
] as const satisfies readonly AdapterKey[];

export type LegacyAdapterKey = (typeof LEGACY_BACKLOG_ADAPTERS)[number];

/** A surface this adapter records, under the part name the envelope gives it. */
export type StoredSourceSurface = {
  readonly disposition: "stored";
  /** The envelope part the response is kept as. */
  readonly part: string;
};

export type ExcludedSourceSurface = {
  readonly disposition: "excluded";
  readonly reason: string;
  readonly [STATED_REASON]: true;
};

export type BacklogSourceSurface = {
  readonly disposition: "backlog";
  readonly reason: string;
  /** Whose baseline line this surface occupies; only a legacy adapter has one. */
  readonly adapter: LegacyAdapterKey;
  readonly [STATED_REASON]: true;
};

/**
 * What an adapter does with one surface its publisher serves for a decision.
 *
 * A field inventory answers "what does the page state"; this answers the
 * question before it — which of the publisher's pages are read at all. A
 * surface nobody decided about is the silence a field inventory cannot break,
 * because the inventory only ever sees the pages already fetched.
 */
export type SourceSurfaceDisposition =
  | StoredSourceSurface
  | ExcludedSourceSurface
  | BacklogSourceSurface;

/** A response the crawl fetches with the decision and keeps as `part`. */
export const storedSourceSurface = (part: string): StoredSourceSurface => ({
  disposition: "stored",
  part,
});

/** State why a surface the publisher serves is not recorded at all. */
export const excludedSourceSurface = <const TText extends string>(
  reason: StatedReason<TText>,
): ExcludedSourceSurface => ({
  disposition: "excluded",
  reason,
  [STATED_REASON]: true,
});

/**
 * A surface that belongs in the row and is not there yet.
 *
 * The adapter argument is the escape's whole cost: only an adapter that
 * already exists can be named, the committed baseline lists the surfaces each
 * one may leave, and the conformance suite fails both ways — so the set
 * shrinks as families enrol and can never grow with a new source.
 */
export const backlogSurface = <const TText extends string>(
  adapter: LegacyAdapterKey,
  reason: StatedReason<TText>,
): BacklogSourceSurface => ({
  disposition: "backlog",
  reason,
  adapter,
  [STATED_REASON]: true,
});

/**
 * Every surface an adapter's publisher serves for a decision, and its fate.
 *
 * An adapter writes the map `as const satisfies Record<<its SOURCE_SURFACES
 * union>, SourceSurfaceDisposition>`, so a surface listed without a
 * disposition does not compile.
 */
export type SourceSurfaceCensus = {
  readonly surfaces: Readonly<Record<string, SourceSurfaceDisposition>>;
};

/**
 * Every field a source states for one decision, and what becomes of it.
 *
 * Scoped to the per-decision pages an adapter fetches — the labelled detail,
 * print or metadata payloads it parses for a document, not the listing that
 * named it, whose columns the cursor and identity conformance suites cover.
 *
 * `fields` is total over the source's own field names by construction: an
 * adapter declares those names once as a `SOURCE_FIELDS` list and writes the
 * map `as const satisfies Record<<that union>, SourceFieldDisposition>`, so a
 * name added to the list without a disposition does not compile.
 *
 * `listSourceFields` reads the whole stored envelope, not one page: a source
 * states fields across the responses it serves for a decision — a listing row,
 * a detail payload, a document — and an inventory that could only see one of
 * them would declare the others out of scope by accident. The conformance
 * suite drives it over each adapter's fixture: a name it returns that the map
 * does not hold fails with the field name, which is the check a per-adapter
 * test cannot make about the fields its author never noticed.
 */
type DeclaredSourceFieldInventory = {
  readonly status: "declared";
  readonly fields: Readonly<Record<string, SourceFieldDisposition>>;
  readonly listSourceFields: (parts: SourceRawParts) => readonly string[];
};

/**
 * The adapters that may still declare no field inventory.
 *
 * Exactly the names in `source-field-inventory-baseline.json`, and closed for
 * the same reason {@link LegacyAdapterKey} is: a source registered tomorrow
 * cannot name itself into the exemption, because the union it would have to
 * join is written here rather than derived from the registry.
 */
const LEGACY_UNINVENTORIED_ADAPTERS = [
  ADAPTER_KEYS.PL_COURTS,
  ADAPTER_KEYS.EU_ECJ,
] as const satisfies readonly AdapterKey[];

export type LegacyUninventoriedAdapter =
  (typeof LEGACY_UNINVENTORIED_ADAPTERS)[number];

/**
 * An adapter that has not inventoried its source fields yet, and says which
 * one it is: the name is what the committed baseline is compared against, so a
 * pending inventory copied between adapters fails instead of hiding one.
 */
export type PendingSourceFieldInventory<
  TAdapter extends LegacyUninventoriedAdapter,
> = {
  readonly status: "pending-inventory";
  readonly adapter: TAdapter;
};

/**
 * An adapter's inventory, or the one sanctioned way to not have one yet.
 *
 * `pending-inventory` is a ratchet, not an option: the committed baseline in
 * `source-field-inventory-baseline.json` names exactly which adapters may
 * declare it, and the conformance suite fails both ways — a pending adapter
 * missing from the baseline, and a baseline entry that has since enrolled. The
 * set can therefore only shrink.
 */
export type SourceFieldInventory =
  | DeclaredSourceFieldInventory
  | PendingSourceFieldInventory<LegacyUninventoriedAdapter>;

/**
 * For an adapter whose source fields nobody has inventoried yet. Written out
 * at the adapter rather than defaulted, so enrolment is a visible edit and the
 * baseline can name what is left.
 */
export const pendingSourceFieldInventory = <
  const TAdapter extends LegacyUninventoriedAdapter,
>(
  adapter: TAdapter,
): PendingSourceFieldInventory<TAdapter> => ({
  status: "pending-inventory",
  adapter,
});

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
   * Every field this source states for a decision, stored or excluded with a
   * reason. Required: a field nobody decided about is how published material
   * an adapter already fetches goes unstored, and the decision has to live in
   * the adapter rather than in whoever last read the page.
   *
   * `pendingSourceFieldInventory` is the only way to not have one, and the
   * committed baseline names every adapter allowed to call it.
   */
  sourceFields: SourceFieldInventory;
  /**
   * Every surface this publisher serves for a decision, and whether the row
   * records it. Required, and the step before the field inventory: an
   * inventory can only ever account for the pages an adapter already fetches,
   * so a page nobody fetches is invisible to it. A surface left unrecorded is
   * a `backlog` entry with a reason and a line in the committed baseline, not
   * a page nobody wrote down.
   */
  sourceSurfaces: SourceSurfaceCensus;
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

type SourceAdapterDefinition<TKey extends AdapterKey> = Omit<
  SourceAdapter,
  "country" | "key" | "name"
> & { readonly key: TKey };

/** Build an adapter from the source facts declared for its registry key. */
export const defineSourceAdapter = <const TKey extends AdapterKey>(
  adapter: SourceAdapterDefinition<TKey>,
): SourceAdapter & { readonly key: TKey } => ({
  ...adapter,
  country: ADAPTER_MANIFESTS[adapter.key].country,
  name: ADAPTER_MANIFESTS[adapter.key].name,
});
