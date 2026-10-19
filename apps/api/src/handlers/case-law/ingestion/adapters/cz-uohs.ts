import { Result, TaggedError, panic } from "better-result";
import * as v from "valibot";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  readPublisherBytes,
  readPublisherText,
  unreadPublisherError,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { normalizeDecisionIdentifierValue } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  extractPlSnLines,
  PL_PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

const LISTING_URL = "https://uohs.gov.cz/opendata/rozhodnuti.jsonld";
const ORIGIN = "https://uohs.gov.cz";
const HOST_POLICY = { type: "exact-origin", origins: [ORIGIN] } as const;
const raise = <T>(error: unknown): T => Result.err<T>(error).unwrap();
const PAGE_SIZE = 20;

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

export class CzUohsUnknownCollectionError extends TaggedError(
  "CzUohsUnknownCollectionError",
)<{ message: string; odbor: readonly string[] }> {}

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

export const parseCzUohsListing = (payload: unknown): CzUohsRecord[] => {
  if (!isRecord(payload) || !Array.isArray(payload["rozhodnutí"])) {
    return raise(
      new AdapterFetchError({
        message: "ÚOHS listing has no rozhodnutí array",
        adapterKey: ADAPTER_KEYS.CZ_UOHS,
        cursor: null,
      }),
    );
  }
  return v.parse(v.array(recordSchema), payload["rozhodnutí"]);
};

export const czUohsCollectionOf = (
  record: Pick<CzUohsRecord, "odbor">,
): CzUohsCollection => {
  const values = record.odbor
    .map(collectionFromUrl)
    .filter((value): value is CzUohsCollection => value !== undefined);
  if (values.length !== 1) {
    return raise(
      new CzUohsUnknownCollectionError({
        message: "ÚOHS decision has an unknown odbor",
        odbor: record.odbor,
      }),
    );
  }
  return values.at(0) ?? panic("validated ÚOHS collection disappeared");
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

const readListingText = async (signal?: AbortSignal): Promise<string> => {
  const outcome = await readPublisherText(
    LISTING_URL,
    publisherReadOptions("listing", signal),
  );
  if (outcome.type === "present") {
    return outcome.value;
  }
  return raise(
    unreadPublisherError({
      outcome,
      message: "ÚOHS listing could not be read",
      adapterKey: ADAPTER_KEYS.CZ_UOHS,
      cursor: null,
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

const pdfText = async (bytes: Uint8Array): Promise<string> => {
  const lines = await extractPlSnLines(
    bytes,
    PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
  );
  return lines
    .map((line) =>
      line.type === "blank" ? "" : line.runs.map(({ text }) => text).join(""),
    )
    .join("\n")
    .trim();
};

export const buildCzUohsDecision = async (
  record: CzUohsRecord,
  listingRetrievedAt: string,
  signal?: AbortSignal,
): Promise<IngestionResult> => {
  const collection = czUohsCollectionOf(record);
  const document = record.dokument.at(0);
  const documentUrl = document?.url;
  let bytes: Uint8Array | undefined;
  let fulltext: string | undefined;
  let extractionFailure: string | undefined;
  let documentRetrievedAt: string | undefined;
  if (documentUrl !== undefined) {
    const target = restrictOutboundUrl({
      hostPolicy: HOST_POLICY,
      rawUrl: documentUrl,
    });
    if (target === null) {
      return raise(
        new AdapterFetchError({
          message: "ÚOHS document escaped publisher origin",
          adapterKey: ADAPTER_KEYS.CZ_UOHS,
          cursor: null,
        }),
      );
    }
    const outcome = await readPublisherBytes(target, {
      ...publisherReadOptions("document", signal),
      redirect: "error",
    });
    if (outcome.type !== "present") {
      return raise(
        unreadPublisherError({
          outcome,
          message: "ÚOHS PDF could not be read",
          adapterKey: ADAPTER_KEYS.CZ_UOHS,
          cursor: null,
        }),
      );
    }
    documentRetrievedAt = Temporal.Now.instant().toString();
    const documentBytes = outcome.value;
    bytes = documentBytes;
    const extracted = await Result.tryPromise({
      try: async () => await pdfText(documentBytes),
      catch: String,
    });
    if (Result.isError(extracted) || extracted.value.length === 0) {
      extractionFailure = Result.isError(extracted)
        ? extracted.error
        : "empty-text";
    } else {
      fulltext = extracted.value;
    }
  }
  const rawRecord = JSON.stringify(record);
  const sourceRaw = encodeSourceRawEnvelope({
    listing: rawRecord,
    provenance: JSON.stringify({
      listing: {
        url: LISTING_URL,
        retrievedAt: listingRetrievedAt,
        sha256: sha256Hex(rawRecord),
      },
      ...(bytes === undefined
        ? {}
        : {
            document: {
              url: documentUrl,
              retrievedAt: documentRetrievedAt,
              sha256: sha256Hex(bytes),
            },
          }),
    }),
  });
  const identifiers = czUohsDecisionIdentifiers(record);
  return plainTextIngestionResult({
    caseNumber: identifiers[0].value,
    caseNumberType: "case-number",
    identifiers,
    sourceDocumentId: record.iri,
    court: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_UOHS].publisher,
    country: "CZE",
    language: "cs",
    ...(record.datum_právní_moci === undefined
      ? {}
      : { decisionDate: record.datum_právní_moci.datum }),
    decisionType: "rozhodnutí",
    ...(fulltext === undefined ? {} : { fulltext }),
    sourceUrl: record.iri,
    ...(documentUrl === undefined ? {} : { documentUrl }),
    textFields: absentDecisionTextFields(
      extractionFailure === undefined
        ? TEXT_ABSENCE_REASON.NOT_PUBLISHED
        : TEXT_ABSENCE_REASON.PARSE_FAILED,
    ),
    metadata: checkedDecisionMetadata({
      subject: record.věc,
      referenceNumber: record.číslo_jednací,
      fileNumber: record.spisová_značka,
      instance: record.instance,
      department: record.odbor,
      collection,
      legalForceDate: record.datum_právní_moci ?? null,
      proceedingTypes: record.typ_řízení,
      decisionTypes: record.typ_rozhodnutí,
      participants: record.účastník,
      recordTypes: record.typ,
      documents: record.dokument,
      ...(extractionFailure === undefined
        ? {}
        : {
            documentExtraction: { type: "failed", reason: extractionFailure },
          }),
    }),
    rawHash: sourceFingerprint({
      sourceRaw,
      ...(bytes === undefined
        ? {}
        : {
            sourceRawObjects: {
              document: { bytes, contentType: "application/pdf" },
            },
          }),
    }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS],
    documentAst: EMPTY_AST,
    sourceRaw,
    ...(bytes === undefined
      ? {}
      : {
          sourceRawObjects: {
            document: { bytes, contentType: "application/pdf" },
          },
        }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
};

const readListing = async (signal?: AbortSignal) => {
  const raw = await readListingText(signal);
  const retrievedAt = Temporal.Now.instant().toString();
  return {
    records: parseCzUohsListing(JSON.parse(raw)),
    retrievedAt,
  };
};

const nextCollection = (slice: string, step: number): string | null => {
  let index = -1;
  for (const [candidateIndex, collection] of CZ_UOHS_COLLECTIONS.entries()) {
    if (collection === slice) {
      index = candidateIndex;
    }
  }
  return index === -1 ? null : (CZ_UOHS_COLLECTIONS[index + step] ?? null);
};

export const czUohsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_UOHS,
  documentStage: "inline",
  language: "cs",
  minRequestIntervalMs: 0,
  sourceSurfaces: {
    surfaces: {
      listing: storedSourceSurface("listing"),
      document: storedSourceSurface("document"),
    },
  },
  sourceFields: {
    status: "declared",
    fields: {
      typ: { disposition: "stored", target: { type: "metadata", key: "typ" } },
      iri: { disposition: "stored", target: { type: "metadata", key: "iri" } },
      věc: { disposition: "stored", target: { type: "metadata", key: "věc" } },
      číslo_jednací: {
        disposition: "stored",
        target: { type: "metadata", key: "číslo_jednací" },
      },
      spisová_značka: {
        disposition: "stored",
        target: { type: "metadata", key: "spisová_značka" },
      },
      instance: {
        disposition: "stored",
        target: { type: "metadata", key: "instance" },
      },
      odbor: {
        disposition: "stored",
        target: { type: "metadata", key: "odbor" },
      },
      datum_právní_moci: {
        disposition: "stored",
        target: { type: "metadata", key: "datum_právní_moci" },
      },
      účastník: {
        disposition: "stored",
        target: { type: "metadata", key: "účastník" },
      },
      typ_řízení: {
        disposition: "stored",
        target: { type: "metadata", key: "typ_řízení" },
      },
      typ_rozhodnutí: {
        disposition: "stored",
        target: { type: "metadata", key: "typ_rozhodnutí" },
      },
      dokument: {
        disposition: "stored",
        target: { type: "metadata", key: "dokument" },
      },
    },
    listSourceFields: ({ listing }) => {
      const parsed: unknown = JSON.parse(listing ?? "{}");
      return isRecord(parsed) ? Object.keys(parsed) : [];
    },
  },
  fetchPage: async (cursor, _config, signal) => {
    const offset = Number(cursor ?? "0");
    const { records, retrievedAt } = await readListing(signal);
    const selected = records.slice(offset, offset + PAGE_SIZE);
    const decisions: IngestionResult[] = [];
    for (const record of selected) {
      decisions.push(await buildCzUohsDecision(record, retrievedAt, signal));
    }
    return Result.ok({
      decisions,
      nextCursor:
        offset + PAGE_SIZE >= records.length
          ? String(offset)
          : String(offset + PAGE_SIZE),
    });
  },
  getTotalCount: async (signal) =>
    sourceTotalRead((await readListing(signal)).records.length),
  reconciliation: {
    firstSlice: CZ_UOHS_COLLECTIONS[0],
    sliceOf: () => "pristup-k-dopravni-infrastrukture",
    nextSlice: (slice) => nextCollection(slice, 1),
    previousSlice: (slice) => nextCollection(slice, -1),
    tipWindowDays: 1,
    revisionOf: (payload) => payload,
    listSlicePage: async ({ slice, page, signal }) => {
      const { records } = await readListing(signal);
      const matches = records.filter(
        (record) => czUohsCollectionOf(record) === slice,
      );
      return {
        items:
          page === 0
            ? matches.map((payload) => ({
                identity: {
                  type: "document",
                  sourceDocumentId: payload.iri,
                },
                payload,
              }))
            : [],
        totalPages: matches.length === 0 ? 0 : 1,
      };
    },
    buildDecision: async (payload, signal) =>
      isRecord(payload)
        ? {
            type: "built",
            decision: await buildCzUohsDecision(
              v.parse(recordSchema, payload),
              Temporal.Now.instant().toString(),
              signal,
            ),
          }
        : { type: "unkeyable" },
  },
});
