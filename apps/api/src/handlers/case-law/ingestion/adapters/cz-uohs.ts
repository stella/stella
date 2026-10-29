// parser-output-unchanged: [cz-uohs] only records listed with an empty, over-long or unsanitizable IRI change, which the pipeline refused before and now stores listing-only under a quarantine id; keyed rows gain a repair-only alias, nothing they store.
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";
import type { Block, DocumentAst, Inline } from "@stll/legal-ast/document-ast";
import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readPublisherBytes,
  readPublisherText,
  unreadPublisherError,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { adapterCatch } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { normalizeDecisionIdentifierValue } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  assemblePlSnParagraphs,
  extractPlPdfSeparatedContent,
  PL_PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnRun } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  READ_OUTCOME_METADATA_KEY,
  type StoredReadOutcome,
  storedReadUnavailable,
  UNAVAILABLE_CYCLES_BEFORE_MARKING,
} from "@/api/lib/errors/read-outcome";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  isPersistableSourceDocumentId,
  type ListingIdentity,
} from "@/api/lib/legal-search/ingestion-types";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  QUARANTINE_NAMESPACE,
  type QuarantineIdentity,
  quarantineIdentity,
  type RepairAlias,
} from "@/api/lib/legal-search/quarantine-identity";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

const LISTING_URL = "https://uohs.gov.cz/opendata/rozhodnuti.jsonld";
const ORIGIN = "https://uohs.gov.cz";
const HOST_POLICY = { type: "exact-origin", origins: [ORIGIN] } as const;
const PAGE_SIZE = 20;
const CURSOR_VERSION = 1;

export const CZ_UOHS_COLLECTIONS = [
  "hospodarska-soutez",
  "verejne-zakazky",
  "verejna-podpora",
  "vyznamna-trzni-sila",
  "pristup-k-dopravni-infrastrukture",
] as const;
export type CzUohsCollection = (typeof CZ_UOHS_COLLECTIONS)[number];

const collectionFromUrl = (url: string): CzUohsCollection | undefined =>
  CZ_UOHS_COLLECTIONS.find(
    (collection) => url === `https://uohs.gov.cz/cs/${collection}.html`,
  );

const recordSchema = v.looseObject({
  typ: v.unknown(),
  iri: v.string(),
  věc: v.looseObject({ cs: v.string() }),
  číslo_jednací: v.string(),
  spisová_značka: v.string(),
  instance: v.array(v.string()),
  odbor: v.array(v.string()),
  datum_právní_moci: v.optional(
    v.looseObject({ typ: v.string(), datum: v.string() }),
  ),
  účastník: v.array(v.unknown()),
  typ_řízení: v.array(v.string()),
  typ_rozhodnutí: v.array(v.string()),
  dokument: v.array(v.looseObject({ typ: v.string(), url: v.string() })),
});
type CzUohsRecord = v.InferOutput<typeof recordSchema>;

const listingSchema = v.looseObject({ rozhodnutí: v.array(recordSchema) });

export const parseCzUohsListing = (payload: unknown): CzUohsRecord[] =>
  v.parse(listingSchema, payload).rozhodnutí;

/**
 * The collection a decision belongs to, or undefined when its departments do
 * not name exactly one known collection. An unknown department is a new
 * publisher category, not a reason to stop the walk: the decision is still
 * stored, keeping its department URLs, with no collection.
 */
export const czUohsCollectionOf = (
  record: Pick<CzUohsRecord, "odbor">,
): CzUohsCollection | undefined => {
  const values = record.odbor
    .map(collectionFromUrl)
    .filter((value): value is CzUohsCollection => value !== undefined);
  return values.length === 1 ? values.at(0) : undefined;
};

const publisherReadOptions = (
  stage: "listing" | "document",
  signal?: AbortSignal,
) => ({
  adapterKey: ADAPTER_KEYS.CZ_UOHS,
  fetchStage: stage,
  timeoutMs: stage === "document" ? 120_000 : ADAPTER_TIMEOUT.LIST,
  signal,
  redirect: "error" as const,
});

const readListingText = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<string, AdapterFetchError>> => {
  // A refused listing is the source refusing the crawl, not one document.
  const outcome = await readPublisherText(LISTING_URL, {
    ...publisherReadOptions("listing", signal),
    refusalScope: "source",
  });
  if (outcome.type === "present") {
    return Result.ok(outcome.value);
  }
  return Result.err(
    unreadPublisherError({
      outcome,
      message: "ÚOHS listing could not be read",
      adapterKey: ADAPTER_KEYS.CZ_UOHS,
      cursor,
    }),
  );
};

export const czUohsDecisionIdentifiers = (
  record: Pick<CzUohsRecord, "spisová_značka" | "číslo_jednací">,
) => {
  const identifier = (value: string) => {
    const prefixed = `ÚOHS-${value.replace(/^ÚOHS-/u, "")}`;
    return {
      type: DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER,
      value: normalizeDecisionIdentifierValue(
        DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER,
        prefixed,
      ),
    } as const;
  };
  return [
    identifier(record.spisová_značka),
    identifier(record.číslo_jednací),
  ] as const;
};

/** Why a listed decision is stored under its quarantine identity. */
const CZ_UOHS_QUARANTINE_REASON = {
  MISSING_IRI: "missing-record-iri",
  UNPERSISTABLE_IRI: "unpersistable-record-iri",
} as const;

type CzUohsQuarantineReason =
  (typeof CZ_UOHS_QUARANTINE_REASON)[keyof typeof CZ_UOHS_QUARANTINE_REASON];

/**
 * How a listed decision is keyed. `keyed` is a decision whose IRI the
 * decision table can hold byte for byte. `quarantined` is one listed without
 * such an IRI but with a file or reference number: it is kept as its listing
 * row (case-law AGENTS.md rule 20) under the quarantine identity of its
 * stable fields. `no-stable-field` is one stating neither, which nothing can
 * name again.
 */
type CzUohsRecordIdentity =
  CzUohsKeyedIdentity | CzUohsQuarantinedIdentity | { type: "no-stable-field" };

type CzUohsKeyedIdentity = {
  type: "keyed";
  sourceDocumentId: string;
  /** The quarantine id this decision would have had without its IRI. */
  repairAliases: readonly RepairAlias[];
};

type CzUohsQuarantinedIdentity = {
  type: "quarantined";
  quarantine: QuarantineIdentity;
  reason: CzUohsQuarantineReason;
  /** The file and reference numbers the decision states, file number first. */
  identifiers: DecisionIdentifiers;
};

/** A stated value, or undefined for one that is empty once trimmed. */
const statedText = (value: string): string | undefined =>
  value.trim().length === 0 ? undefined : value;

/**
 * The quarantine identity of a decision's stable fields, or undefined for one
 * stating neither a file nor a reference number.
 *
 * The file number, the reference number and the subject: what the office
 * states for the decision itself, whatever its IRI. The IRI is the identity
 * that is missing; the document URLs and the participant and code-list IRIs
 * are links the export can reissue together with it; the date of legal force
 * is added once the decision becomes final, so a later keyed observation would
 * hash differently; and the record types are the same for every decision.
 * The subject alone names a matter, which the office decides in several
 * instances, so it only refines a fingerprint and is never one on its own.
 */
const czUohsQuarantine = (
  record: Pick<CzUohsRecord, "spisová_značka" | "číslo_jednací" | "věc">,
): QuarantineIdentity | undefined => {
  const fileNumber = statedText(record.spisová_značka);
  const referenceNumber = statedText(record.číslo_jednací);
  return fileNumber === undefined && referenceNumber === undefined
    ? undefined
    : quarantineIdentity({
        namespace: QUARANTINE_NAMESPACE.CZ_UOHS,
        stableFields: {
          fileNumber,
          referenceNumber,
          subject: statedText(record.věc.cs),
        },
      });
};

/**
 * Whether an IRI is one the decision table can hold exactly as published.
 * The pipeline refuses an empty or over-long identity and one that text
 * sanitization would rewrite, so a decision listed with such an IRI is
 * quarantined here rather than keyed on an identity no row can carry.
 */
const isStorableIri = (iri: string): boolean =>
  isPersistableSourceDocumentId(iri) && stripDangerousChars(iri) === iri;

/**
 * How this adapter keys a listed decision. Stated once, because the crawl,
 * the reconciliation listing and its build must agree exactly on which
 * decisions exist and what each is stored under.
 */
const czUohsRecordIdentity = (record: CzUohsRecord): CzUohsRecordIdentity => {
  const quarantine = czUohsQuarantine(record);
  if (isStorableIri(record.iri)) {
    return {
      type: "keyed",
      sourceDocumentId: record.iri,
      repairAliases: quarantine?.repairAliases ?? [],
    };
  }
  // Only the numbers the decision states: the docket of its listing-only row
  // is the first, never the bare prefix an empty number would leave.
  const [fileNumber, referenceNumber] = czUohsDecisionIdentifiers(record);
  const [first, ...rest] = [
    ...(statedText(record.spisová_značka) === undefined ? [] : [fileNumber]),
    ...(statedText(record.číslo_jednací) === undefined
      ? []
      : [referenceNumber]),
  ];
  if (quarantine === undefined || first === undefined) {
    return { type: "no-stable-field" };
  }
  return {
    type: "quarantined",
    quarantine,
    reason:
      record.iri.length === 0
        ? CZ_UOHS_QUARANTINE_REASON.MISSING_IRI
        : CZ_UOHS_QUARANTINE_REASON.UNPERSISTABLE_IRI,
    identifiers: [first, ...rest],
  };
};

/**
 * The identity the reconciliation lists a decision under, or undefined for
 * one with no stable field, which the walk counts instead of listing.
 */
export const czUohsListingIdentity = (
  record: CzUohsRecord,
): ListingIdentity | undefined => {
  const identity = czUohsRecordIdentity(record);
  switch (identity.type) {
    case "keyed":
      return { type: "document", sourceDocumentId: identity.sourceDocumentId };
    case "quarantined":
      return {
        type: "document",
        sourceDocumentId: identity.quarantine.sourceDocumentId,
      };
    case "no-stable-field":
      return undefined;
    default: {
      identity satisfies never;
      return panic(`Unhandled ÚOHS identity: ${JSON.stringify(identity)}`);
    }
  }
};

type CzUohsPdf = {
  /** The text layer line by line, letterhead first. */
  text: string;
  /** The typeset lines joined back into the paragraphs they were broken from. */
  paragraphs: PlSnRun[][];
  notes: { label: string; noteId: string; runs: PlSnRun[] }[];
};

// The office numbers its reasoning with a hanging indent ("1.  Úřad obdržel").
const readCzUohsPdf = async (bytes: Uint8Array): Promise<CzUohsPdf> => {
  const { body, notes } = await extractPlPdfSeparatedContent(
    bytes,
    PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
  );
  const noteGroups = new Map<
    string,
    { label: string; noteId: string; lines: typeof notes }
  >();
  for (const line of notes) {
    if (line.type !== "text" || line.footnote === undefined) {
      continue;
    }
    const group = noteGroups.get(line.footnote.noteId) ?? {
      ...line.footnote,
      lines: [],
    };
    group.lines.push(line);
    noteGroups.set(line.footnote.noteId, group);
  }
  return {
    text: body
      .map((line) =>
        line.type === "blank" ? "" : line.runs.map(({ text }) => text).join(""),
      )
      .join("\n")
      .trim(),
    paragraphs: assemblePlSnParagraphs(body),
    notes: [...noteGroups.values()].map(({ label, noteId, lines }) => ({
      label,
      noteId,
      runs: assemblePlSnParagraphs(lines).flat(),
    })),
  };
};

type CzUohsDocumentInput = {
  paragraphs: readonly PlSnRun[][];
  notes: readonly { label: string; noteId: string; runs: PlSnRun[] }[];
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string;
  documentUrl: string | undefined;
};

/**
 * The decision as a document: one paragraph block per printed paragraph, with
 * the office's own "N." numbering moved into the block by the shared reader.
 */
export const czUohsDocumentAst = ({
  paragraphs,
  notes,
  caseNumber,
  court,
  decisionDate,
  decisionType,
  sourceUrl,
  documentUrl,
}: CzUohsDocumentInput): DocumentAst => {
  // The unnumbered letterhead and operative part precede the numbered
  // reasoning; keeping them out of the body-numbering candidate set prevents
  // their typeset paragraphs from counting as an implausibly long lead-in.
  const textOf = (runs: readonly PlSnRun[]) =>
    runs
      .map(({ text }) => text)
      .join("")
      .trim();
  const inlinesOf = (runs: readonly PlSnRun[]): Inline[] =>
    runs.map(({ text, footnoteReference }): Inline =>
      footnoteReference === undefined
        ? { type: "text", text }
        : {
            type: "link",
            href: `#footnote-${footnoteReference}`,
            children: [
              {
                type: "superscript" as const,
                children: [{ type: "text" as const, text }],
              },
            ],
          },
    );
  const numberedReasoningStart = paragraphs.findIndex((runs) =>
    /^1\.\s+\p{Lu}/u.test(textOf(runs)),
  );
  const blocks: Block[] = paragraphs.map((runs, index) => ({
    id: `b${index + 1}`,
    anchorId: `p-${index + 1}`,
    type: "paragraph",
    ...(numberedReasoningStart !== -1 && index < numberedReasoningStart
      ? { role: "holding" as const }
      : {}),
    inlines: inlinesOf(runs),
    plainText: textOf(runs),
  }));
  for (const { label, noteId, runs } of notes) {
    const plainText = textOf(runs);
    blocks.push({
      id: `b${blocks.length + 1}`,
      anchorId: noteId,
      type: "paragraph",
      note: { type: "footnote", label, noteId },
      inlines: inlinesOf(runs),
      plainText,
    });
  }
  return {
    version: 1,
    source: {
      system: "uohs.gov.cz",
      documentId: sourceUrl,
      webUrl: sourceUrl,
      printUrl: documentUrl ?? "",
    },
    metadata: {
      caseNumber,
      ecli: null,
      court,
      decisionDate: decisionDate ?? null,
      decisionType: decisionType ?? null,
      keywords: [],
      statutes: [],
    },
    blocks: courtParagraphNumbers(blocks, {
      parser: ADAPTER_KEYS.CZ_UOHS,
      caseNumber,
      url: sourceUrl,
    }),
  };
};

/** The decision's document, or the empty placeholder when no file yielded text. */
const decisionDocumentAst = (
  canonical: (CzUohsPdf & { url: string }) | undefined,
  identity: Omit<CzUohsDocumentInput, "paragraphs" | "notes" | "documentUrl">,
) =>
  canonical === undefined
    ? EMPTY_AST
    : czUohsDocumentAst({
        ...identity,
        paragraphs: canonical.paragraphs,
        notes: canonical.notes,
        documentUrl: canonical.url,
      });

/** One recorded decision PDF as the adapter reads it, for evidence checks. */
export const parseCzUohsDocumentPdf = async (
  bytes: Uint8Array,
  identity: Pick<CzUohsDocumentInput, "caseNumber" | "sourceUrl">,
): Promise<DocumentAst> => {
  const read = await readCzUohsPdf(bytes);
  return czUohsDocumentAst({
    ...identity,
    paragraphs: read.paragraphs,
    notes: read.notes,
    court: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_UOHS].publisher,
    decisionDate: czUohsLetterheadDate(read.text),
    decisionType: undefined,
    documentUrl: undefined,
  });
};

/**
 * The letterhead of every ÚOHS decision states its issue date beside the
 * place: "Datum, místo  12. 10. 2026, Brno". Body dates ("dne 5. 8. 2026")
 * never carry the place, so only the labelled letterhead value is read, and
 * only from the head of the text.
 */
const LETTERHEAD_SPAN = 1500;
// The value must follow its own label: a date elsewhere in the head is not it.
const LETTERHEAD_DATE =
  /Datum,\s*místo\s+(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}),\s*Brno/u;

/** Where a ÚOHS decision date was read from; the export states none. */
export const CZ_UOHS_DECISION_DATE_SOURCE = "document";

export const czUohsLetterheadDate = (text: string): string | undefined => {
  const match = LETTERHEAD_DATE.exec(text.slice(0, LETTERHEAD_SPAN));
  if (match === null) {
    return undefined;
  }
  const [, day, month, year] = match;
  const date = Result.try({
    try: () =>
      Temporal.PlainDate.from(
        { year: Number(year), month: Number(month), day: Number(day) },
        { overflow: "reject" },
      ).toString(),
    catch: String,
  });
  return Result.isOk(date) ? date.value : undefined;
};

/**
 * How the decision date was established: read from the document, stated as
 * not published by a document that carries none, or unknown while the
 * document is unread.
 */
const decisionDateMetadata = (
  decisionDate: string | undefined,
  documentRead: boolean,
) => {
  if (decisionDate !== undefined) {
    return { decisionDateSource: CZ_UOHS_DECISION_DATE_SOURCE };
  }
  if (!documentRead) {
    return {};
  }
  return { decisionDateAvailability: { status: "not-published-by-source" } };
};

/**
 * The export is one JSON-LD document for every decision; each decision keeps
 * its own record, every key included. Provenance names where each stored
 * part came from and its digest, never when it was read, so an unchanged
 * decision keeps its fingerprint across reads.
 */
const czUohsSourceRaw = (
  record: CzUohsRecord,
  documents: Readonly<Record<string, { url: string; sha256: string }>>,
): string => {
  const rawRecord = JSON.stringify(record);
  return encodeSourceRawEnvelope({
    listing: rawRecord,
    provenance: JSON.stringify({
      listing: { url: LISTING_URL, sha256: sha256Hex(rawRecord) },
      documents,
    }),
  });
};

/** The quarantine id a keyed record takes over when its IRI recovers. */
const czUohsRepairAliases = (
  repairAliases: readonly RepairAlias[],
): Pick<IngestionResult, "sourceDocumentIdRepairAliases"> =>
  repairAliases.length === 0
    ? {}
    : { sourceDocumentIdRepairAliases: repairAliases };

const readCzUohsDecision = async (
  record: CzUohsRecord,
  { sourceDocumentId, repairAliases }: CzUohsKeyedIdentity,
  signal?: AbortSignal,
): Promise<IngestionResult> => {
  const collection = czUohsCollectionOf(record);
  const primaryDocumentUrl = record.dokument.at(0)?.url;
  const rawObjectEntries: [
    string,
    { bytes: Uint8Array; contentType: string },
  ][] = [];
  const provenanceEntries: [string, { url: string; sha256: string }][] = [];
  const documentFailures: {
    index: number;
    type: "fetch-failed" | "parse-failed";
    reason: string;
    url: string;
  }[] = [];
  let documentReadOutcome: StoredReadOutcome | undefined;
  // The document the decision text is read from, with the URL it came from.
  let canonical: (CzUohsPdf & { url: string }) | undefined;
  for (const [index, document] of record.dokument.entries()) {
    const part = index === 0 ? "document" : `document-${index}`;
    const documentUrl = document.url;
    const target = restrictOutboundUrl({
      hostPolicy: HOST_POLICY,
      rawUrl: documentUrl,
    });
    if (target === null) {
      documentFailures.push({
        index,
        type: "fetch-failed",
        reason: "document escaped publisher origin",
        url: documentUrl,
      });
      continue;
    }
    const outcome = await readPublisherBytes(target, {
      ...publisherReadOptions("document", signal),
      redirect: "error",
    });
    if (outcome.type !== "present") {
      if (outcome.type === "unavailable") {
        documentReadOutcome = storedReadUnavailable({
          cause: outcome.cause,
          scope: "document",
          consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
        });
      } else if (outcome.type === "refused") {
        documentReadOutcome = { ...outcome, scope: "document" };
      } else {
        documentReadOutcome = outcome;
      }
      documentFailures.push({
        index,
        type: "fetch-failed",
        reason: unreadPublisherError({
          outcome,
          message: "ÚOHS PDF could not be read",
          adapterKey: ADAPTER_KEYS.CZ_UOHS,
          cursor: null,
        }).message,
        url: documentUrl,
      });
      continue;
    }
    const documentBytes = outcome.value;
    rawObjectEntries.push([
      part,
      { bytes: documentBytes, contentType: "application/pdf" },
    ]);
    provenanceEntries.push([
      part,
      { url: documentUrl, sha256: sha256Hex(documentBytes) },
    ]);
    const extracted = await Result.tryPromise({
      try: async () => await readCzUohsPdf(documentBytes),
      catch: String,
    });
    if (Result.isError(extracted) || extracted.value.text.length === 0) {
      documentFailures.push({
        index,
        type: "parse-failed",
        reason: Result.isError(extracted) ? extracted.error : "empty-text",
        url: documentUrl,
      });
    } else {
      // The first successfully parsed document in publisher order is the
      // canonical decision text; every document is still retained below.
      canonical ??= { ...extracted.value, url: documentUrl };
    }
  }
  const sourceRawObjects = Object.fromEntries(rawObjectEntries);
  const sourceRaw = czUohsSourceRaw(
    record,
    Object.fromEntries(provenanceEntries),
  );
  const fulltext = canonical?.text;
  // A link to the document points at the file the text was read from; the
  // first listed file only when none of them yielded text.
  const decisionDocumentUrl = canonical?.url ?? primaryDocumentUrl;
  const identifiers = czUohsDecisionIdentifiers(record);
  // The date comes from the decision's own text; a text without a letterhead
  // date is a source that publishes none. An unread document says neither.
  const decisionDate =
    fulltext === undefined ? undefined : czUohsLetterheadDate(fulltext);
  return plainTextIngestionResult({
    caseNumber: identifiers[0].value,
    caseNumberType: "case-number",
    identifiers,
    sourceDocumentId,
    ...czUohsRepairAliases(repairAliases),
    court: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_UOHS].publisher,
    country: "CZE",
    language: "cs",
    ...(decisionDate === undefined ? {} : { decisionDate }),
    ...(record.typ_rozhodnutí.at(0) === undefined
      ? {}
      : { decisionType: record.typ_rozhodnutí[0] }),
    ...(fulltext === undefined ? {} : { fulltext }),
    ...(fulltext === undefined && documentReadOutcome !== undefined
      ? { isListingOnly: true }
      : {}),
    sourceUrl: record.iri,
    ...(decisionDocumentUrl === undefined
      ? {}
      : { documentUrl: decisionDocumentUrl }),
    textFields: absentDecisionTextFields(
      documentFailures.length === 0 && record.dokument.length === 0
        ? TEXT_ABSENCE_REASON.NOT_PUBLISHED
        : TEXT_ABSENCE_REASON.PARSE_FAILED,
    ),
    metadata: checkedDecisionMetadata({
      subject: record.věc,
      referenceNumber: record.číslo_jednací,
      fileNumber: record.spisová_značka,
      instance: record.instance,
      department: record.odbor,
      collection: collection ?? null,
      // An authority decision carries no ECLI, and the export states none.
      ecliAvailability: { status: "not_published" },
      ...decisionDateMetadata(decisionDate, fulltext !== undefined),
      legalForceDate: record.datum_právní_moci ?? null,
      proceedingTypes: record.typ_řízení,
      decisionTypes: record.typ_rozhodnutí,
      participants: record.účastník,
      recordTypes: record.typ,
      documents: record.dokument,
      ...(documentFailures.length === 0
        ? {}
        : {
            documentExtraction: {
              type: "failed",
              failures: documentFailures,
            },
          }),
      ...(documentReadOutcome === undefined
        ? {}
        : { [READ_OUTCOME_METADATA_KEY]: documentReadOutcome }),
    }),
    rawHash: sourceFingerprint({
      sourceRaw,
      ...(Object.keys(sourceRawObjects).length === 0
        ? {}
        : { sourceRawObjects }),
    }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS],
    documentAst: decisionDocumentAst(canonical, {
      caseNumber: identifiers[0].value,
      court: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_UOHS].publisher,
      decisionDate,
      decisionType: record.typ_rozhodnutí.at(0),
      sourceUrl: record.iri,
    }),
    sourceRaw,
    ...(Object.keys(sourceRawObjects).length === 0 ? {} : { sourceRawObjects }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
};

/**
 * The listing-only row of a decision listed without a storable IRI (rule
 * 20). Its documents are not read: the row is held as its listing until the
 * IRI recovers, and the keyed observation then takes it over through its
 * repair alias and reads them.
 */
const quarantinedCzUohsDecision = (
  record: CzUohsRecord,
  { quarantine, reason, identifiers }: CzUohsQuarantinedIdentity,
): IngestionResult => {
  const collection = czUohsCollectionOf(record);
  const sourceUrl = new URL(LISTING_URL);
  sourceUrl.hash = `quarantine-${quarantine.fingerprint}`;
  const sourceRaw = czUohsSourceRaw(record, {});
  return plainTextIngestionResult({
    caseNumber: identifiers[0].value,
    caseNumberType: "case-number",
    identifiers,
    isListingOnly: true,
    sourceDocumentId: quarantine.sourceDocumentId,
    court: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_UOHS].publisher,
    country: "CZE",
    language: "cs",
    ...(record.typ_rozhodnutí.at(0) === undefined
      ? {}
      : { decisionType: record.typ_rozhodnutí[0] }),
    sourceUrl: sourceUrl.href,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      subject: record.věc,
      referenceNumber: record.číslo_jednací,
      fileNumber: record.spisová_značka,
      instance: record.instance,
      department: record.odbor,
      collection: collection ?? null,
      // An authority decision carries no ECLI, and the export states none.
      ecliAvailability: { status: "not_published" },
      legalForceDate: record.datum_právní_moci ?? null,
      proceedingTypes: record.typ_řízení,
      decisionTypes: record.typ_rozhodnutí,
      participants: record.účastník,
      recordTypes: record.typ,
      documents: record.dokument,
      identityQuarantined: true,
      listedOnly: true,
      listedOnlyReason: reason,
    }),
    rawHash: sourceFingerprint({ sourceRaw }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS],
    documentAst: EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
};

/**
 * The row a listed decision is stored as: read in full under its IRI, or its
 * listing-only row under its quarantine identity.
 *
 * Panics on a decision with no stable field: the crawl and the
 * reconciliation listing count such a decision instead of building it, so
 * meeting one here is a caller that skipped {@link czUohsListingIdentity}.
 */
export const buildCzUohsDecision = async (
  record: CzUohsRecord,
  signal?: AbortSignal,
): Promise<IngestionResult> => {
  const identity = czUohsRecordIdentity(record);
  switch (identity.type) {
    case "keyed":
      return await readCzUohsDecision(record, identity, signal);
    case "quarantined":
      return quarantinedCzUohsDecision(record, identity);
    case "no-stable-field":
      return panic(
        "ÚOHS record states neither a storable IRI nor a file or reference number",
      );
    default: {
      identity satisfies never;
      return panic(`Unhandled ÚOHS identity: ${JSON.stringify(identity)}`);
    }
  }
};

type CzUohsListing = {
  records: CzUohsRecord[];
  snapshotId: string;
};

type CzUohsCursor = {
  version: typeof CURSOR_VERSION;
  afterId?: string;
  parkedOn?: string;
  snapshotId?: string;
};

const listingSnapshots = new Map<string, CzUohsListing>();

const todayUtc = (): string => Temporal.Now.plainDateISO("UTC").toString();

export const encodeCzUohsCursor = (cursor: CzUohsCursor): string =>
  JSON.stringify(cursor);

const cursorSchema = v.strictObject({
  version: v.literal(CURSOR_VERSION),
  afterId: v.optional(v.string()),
  parkedOn: v.optional(v.string()),
  snapshotId: v.optional(v.string()),
});

// A cursor this adapter did not write is refused: restarting the walk would
// silently re-fetch every decision.
export const parseCzUohsCursor = (
  cursor: string | null,
): Result<CzUohsCursor, AdapterFetchError> =>
  cursor === null
    ? Result.ok({ version: CURSOR_VERSION })
    : Result.try({
        try: (): CzUohsCursor => {
          const { afterId, parkedOn, snapshotId } = v.parse(
            cursorSchema,
            JSON.parse(cursor),
          );
          return {
            version: CURSOR_VERSION,
            ...(afterId === undefined ? {} : { afterId }),
            ...(parkedOn === undefined ? {} : { parkedOn }),
            ...(snapshotId === undefined ? {} : { snapshotId }),
          };
        },
        catch: adapterCatch(ADAPTER_KEYS.CZ_UOHS, cursor),
      });

const readListing = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<CzUohsListing, AdapterFetchError>> => {
  const rawResult = await readListingText(cursor, signal);
  if (Result.isError(rawResult)) {
    return rawResult;
  }
  const raw = rawResult.value;
  return Result.try({
    try: () => ({
      records: parseCzUohsListing(JSON.parse(raw)).toSorted((left, right) => {
        if (left.iri === right.iri) {
          return 0;
        }
        return left.iri < right.iri ? -1 : 1;
      }),
      snapshotId: sha256Hex(raw),
    }),
    catch: adapterCatch(ADAPTER_KEYS.CZ_UOHS, cursor),
  });
};

const listingForCursor = async (
  cursor: string | null,
  position: CzUohsCursor,
  signal?: AbortSignal,
): Promise<Result<CzUohsListing, AdapterFetchError>> => {
  const cached =
    position.snapshotId === undefined
      ? undefined
      : listingSnapshots.get(position.snapshotId);
  if (cached !== undefined && position.parkedOn === undefined) {
    return Result.ok(cached);
  }
  const read = await readListing(cursor, signal);
  if (Result.isError(read)) {
    return read;
  }
  listingSnapshots.clear();
  listingSnapshots.set(read.value.snapshotId, read.value);
  return read;
};

export const czUohsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_UOHS,
  documentStage: "inline",
  language: "cs",
  minRequestIntervalMs: publisherRequestIntervalMs(ADAPTER_KEYS.CZ_UOHS),
  sourceSurfaces: {
    surfaces: {
      listing: storedSourceSurface("listing"),
      document: storedSourceSurface("document"),
    },
  },
  sourceFields: {
    status: "declared",
    fields: {
      typ: {
        disposition: "stored",
        target: { type: "metadata", key: "recordTypes" },
      },
      iri: { disposition: "stored", target: { type: "identity" } },
      věc: {
        disposition: "stored",
        target: { type: "metadata", key: "subject" },
      },
      číslo_jednací: {
        disposition: "stored",
        target: { type: "metadata", key: "referenceNumber" },
      },
      spisová_značka: {
        disposition: "stored",
        target: { type: "metadata", key: "fileNumber" },
      },
      instance: {
        disposition: "stored",
        target: { type: "metadata", key: "instance" },
      },
      odbor: {
        disposition: "stored",
        target: { type: "metadata", key: "department" },
      },
      datum_právní_moci: {
        disposition: "stored",
        target: { type: "metadata", key: "legalForceDate" },
      },
      účastník: {
        disposition: "stored",
        target: { type: "metadata", key: "participants" },
      },
      typ_řízení: {
        disposition: "stored",
        target: { type: "metadata", key: "proceedingTypes" },
      },
      typ_rozhodnutí: {
        disposition: "stored",
        target: { type: "metadata", key: "decisionTypes" },
      },
      dokument: {
        disposition: "stored",
        target: { type: "metadata", key: "documents" },
      },
    },
    listSourceFields: ({ listing }) => {
      const parsed: unknown = JSON.parse(listing ?? "{}");
      return isRecord(parsed) ? Object.keys(parsed) : [];
    },
  },
  fetchPage: async (cursor, _config, signal) => {
    const parsedPosition = parseCzUohsCursor(cursor);
    if (Result.isError(parsedPosition)) {
      return parsedPosition;
    }
    const position = parsedPosition.value;
    const encoded = encodeCzUohsCursor(position);
    if (position.parkedOn !== undefined && position.parkedOn >= todayUtc()) {
      return Result.ok({
        observations: [],
        decisions: [],
        nextCursor: encoded,
      });
    }
    const listing = await listingForCursor(cursor, position, signal);
    if (Result.isError(listing)) {
      return listing;
    }
    // A parked walk resumes after its frontier: one listing read per cycle,
    // new documents only (rule 19); reconciliation covers the rest.
    const afterId = position.afterId;
    const remaining = listing.value.records.filter(
      (record) => afterId === undefined || record.iri > afterId,
    );
    const selected = remaining.slice(0, PAGE_SIZE);
    const decisions: IngestionResult[] = [];
    for (const record of selected) {
      if (czUohsListingIdentity(record) === undefined) {
        // The reconciliation counts it in `withoutStableFields`; this names
        // why the crawl stores nothing for it.
        logger.warn("case_law.ingestion.listing_row_without_stable_field", {
          adapterKey: ADAPTER_KEYS.CZ_UOHS,
          cursor: encoded,
          reason: "no-storable-iri-and-no-file-or-reference-number",
        });
        continue;
      }
      decisions.push(await buildCzUohsDecision(record, signal));
    }
    const lastId = selected.at(-1)?.iri ?? afterId;
    const reachedTip = selected.length < PAGE_SIZE;
    return Result.ok({
      observations: [],
      decisions,
      nextCursor: encodeCzUohsCursor({
        version: CURSOR_VERSION,
        ...(lastId === undefined ? {} : { afterId: lastId }),
        snapshotId: listing.value.snapshotId,
        ...(reachedTip ? { parkedOn: todayUtc() } : {}),
      }),
    });
  },
  getTotalCount: async (signal) => {
    const listing = await readListing(null, signal);
    if (Result.isOk(listing)) {
      return sourceTotalRead(listing.value.records.length);
    }
    return listing.error.httpStatus === undefined
      ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
      : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
  },
  reconciliation: {
    // The publisher exposes one atomic listing, so its one slice contains
    // every collection and makes every newly published record tip-visible.
    firstSlice: "all",
    sliceOf: () => "all",
    nextSlice: () => null,
    previousSlice: () => null,
    tipWindowDays: 1,
    revisionOf: (payload) => payload,
    listSlicePage: async ({ slice, page, signal }) => {
      if (slice !== "all" || page !== 0) {
        return { observations: [], items: [], totalPages: 0 };
      }
      const listing = await readListing(null, signal);
      if (Result.isError(listing)) {
        return await Promise.reject(listing.error);
      }
      const { records } = listing.value;
      const items = records.flatMap((payload) => {
        const identity = czUohsListingIdentity(payload);
        return identity === undefined ? [] : [{ identity, payload }];
      });
      // A decision with no stable field is listed but cannot be keyed: it is
      // counted so coverage shows it, and the crawl warns on it.
      const withoutStableFields = records.length - items.length;
      return {
        observations: [],
        items,
        ...(withoutStableFields === 0 ? {} : { withoutStableFields }),
        totalPages: records.length === 0 ? 0 : 1,
      };
    },
    buildDecision: async (payload, signal) => {
      if (!isRecord(payload)) {
        return { type: "unkeyable" };
      }
      const record = v.parse(recordSchema, payload);
      // A quarantined decision builds its listing-only row, which the walk
      // counts held: there is no detail to wait for until its IRI recovers.
      return czUohsListingIdentity(record) === undefined
        ? { type: "unkeyable" }
        : {
            type: "built",
            decision: await buildCzUohsDecision(record, signal),
          };
    },
  },
});
