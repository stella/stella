// parser-output-unchanged: array partitions use the shared owner with identical items and boundaries; parsed content is unchanged.
// parser-output-unchanged: Crawl listing availability controls checkpoints; stored decision parsing is unchanged.
// parser-output-unchanged: fetch-stage telemetry and document-stage metadata only; parser decision fields are unchanged.
// parser-output-unchanged: Reconciliation revision projections classify listing inputs without changing parsed decision output.
// parser-output-unchanged: Publisher availability uses the shared contract without changing parsed values.
// parser-output-unchanged: [sk-us] failed and refused publisher reads are typed outcomes; served and 404 reads build the same decision.
import { Result, panic } from "better-result";
import * as v from "valibot";

import type { SkUsEcliAvailability } from "@stll/api-contract/case-law-text-field";
import { backoffDelay } from "@stll/concurrency/backoff-delay";
/**
 * Slovak Constitutional Court (Ústavný súd SR) adapter.
 *
 * Fetches decisions from the ustavnysud.sk REST API, a
 * Liferay DXP headless service. ~52,000 decisions from 1993
 * to present.
 *
 * Search: POST /o/v1/dms/search (no auth)
 * PDFs:   GET  /docDownload/{documentId} (no auth)
 *
 * Both endpoints are open. The search endpoint previously sat
 * behind an OAuth2 client_credentials application whose
 * credentials the court shipped in its own JavaScript bundle;
 * that application has since been removed, and the token
 * endpoint now answers `invalid_client` for it. Send no
 * `Authorization` header at all: the endpoint rejects a
 * request carrying one it cannot verify, so a stale token is
 * worse than none.
 *
 * The Liferay DMS search endpoint has an internal pagination
 * cap (~3,000 results per query). To access the full archive,
 * we window queries by year and paginate within each window.
 *
 * Cursor format: "YYYY:offset" (e.g. "1993:0", "2020:1500").
 * Legacy cursors (plain offset like "3060") are migrated
 * to the current year on first use.
 *
 * The same search endpoint is addressable by an arbitrary
 * decision-date range, which is what makes this source
 * reconcilable: a month can be listed on its own, without
 * the crawl cursor ever reaching it. See `reconciliation`
 * at the bottom of this file.
 */
import { classifyFailure } from "@stll/errors";
// parser-output-unchanged: imports the document AST from its package owner
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import type { DocumentFetchStage } from "@stll/legal-atlas/document-fetch-diagnostics";
import { decodeDeclared } from "@stll/mojibake/declared-charset";
import { Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import {
  backlogSurface,
  decodeSourceRawEnvelope,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationListingItem,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
  UnreadListedItem,
  UnreadOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readPublisherBytes,
  readPublisherText,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  normalizeMetadataValues,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
} from "@/api/lib/case-law/decision-text";
import { decisionTypeKey } from "@/api/lib/case-law/decision-type-key";
import {
  READ_OUTCOME_METADATA_KEY,
  readPresent,
  readUnavailable,
  type AbsenceEvidence,
  type ReadOutcome,
  type ReadRefusal,
  type ReadRefusalScope,
  type ReadUnavailableCause,
} from "@/api/lib/errors/read-outcome";
import {
  AdapterFetchError,
  FetchBoundaryError,
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { RawIngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

import { logDocumentParseFailure } from "./document-parse-failure";

// ── Constants ─────────────────────────────────────────────

const BASE_URL = "https://www.ustavnysud.sk";
/** The JSON service; the paths below are relative to it. */
const SERVICE_URL = `${BASE_URL}/o/v1`;
const SEARCH_PATH = "dms/search";
const SEARCH_URL = `${SERVICE_URL}/${SEARCH_PATH}`;
const CONTENT_PATH = "dms/content";
const COURT_FILE_PATH = "dms/file";
const CODELIST_PATH = "codelist/decision";
const DOC_DOWNLOAD_URL = `${BASE_URL}/docDownload`;

/** The corpus this adapter reads; the service echoes it back as `docType`. */
const DECISION_DOC_TYPE = "USSR_DECISION_MK";
const COLLECTION_DOC_TYPE = "USSR_ZNAU";

/**
 * The index fields the service states only as facet counts.
 *
 * `fieldsToReturn` does not widen the projection, so these never appear on
 * a row however they are asked for; a facet query over a result set narrowed
 * to one docket is the only way to read them. Three more the index holds
 * (`mkArticle`, `mkLetter`, `mkClause`, the decomposition the legal-
 * regulation filter searches on) are left out: naming them in `facets`
 * makes the endpoint answer 204 with an empty body.
 */
const FACET_FIELDS = [
  "mkDifferentViewJudges",
  "mkDefendant",
  "mkPublicDefendant",
  "mkViolator",
  "mkFormOfProposer",
  "mkKindOfOtherProposer",
  "mkFileNumberOfDefendantProceeding",
] as const;

type FacetField = (typeof FACET_FIELDS)[number];

/** The vocabularies a decision's judge fields are drawn from. */
const JUDGE_CODELISTS = ["mkJudgeReporter", "mkDifferentViewJudges"] as const;

const PAGE_SIZE = 10;
const SEARCH_RETRY_DELAY_MS = 500;

/** Shortest gap between two requests this adapter makes to the court. */
const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(ADAPTER_KEYS.SK_US);

/**
 * Page size for a listing walk. The crawl takes ten at a time because every
 * item it keeps costs a PDF download; a listing walk downloads nothing, so it
 * asks for the largest page the DMS was observed to honour (a 361-decision
 * month answers 100, 100, 100, 61).
 */
const LISTING_PAGE_SIZE = 100;

/** First year with decisions in the API. */
const FIRST_YEAR = Number.parseInt(
  ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_US].dateRange.fromInclusive.slice(0, 4),
  10,
);

/** The only language this source publishes; half of the stored identity. */
const SK_US_LANGUAGE = "sk";

/**
 * Fields to request from the search API. Empty array
 * returns all fields including the built-in `documentId`.
 * Listing specific fields causes `documentId` to be
 * omitted (Liferay DMS quirk), so we request everything.
 */
const FIELDS_TO_RETURN: string[] = [];

// ── Cursor helpers ──────────────────────────────────────────

type YearCursor = { year: number; offset: number } & (
  | { status: "walking" }
  | { status: "refused-frontier" }
);

const parseCursor = (cursor: string | null): YearCursor => {
  if (!cursor) {
    return { year: FIRST_YEAR, offset: 0, status: "walking" };
  }

  // New format: "YYYY:offset"
  const match = /^(?<year>\d{4}):(?<offset>\d+)(?<refused>:refused)?$/u.exec(
    cursor,
  );
  const { year, offset, refused } = match?.groups ?? {};
  if (year && offset) {
    return {
      year: Number.parseInt(year, 10),
      offset: Number.parseInt(offset, 10),
      status: refused ? "refused-frontier" : "walking",
    };
  }

  // Legacy format: plain offset number (e.g. "3060").
  // The global offset is meaningless with year-windowed queries.
  // Restart from FIRST_YEAR to backfill the full 1993–present
  // archive (~52k decisions, takes a few hours to crawl through).
  const legacyOffset = Number.parseInt(cursor, 10);
  if (!Number.isNaN(legacyOffset)) {
    return { year: FIRST_YEAR, offset: 0, status: "walking" };
  }

  return { year: FIRST_YEAR, offset: 0, status: "walking" };
};

const encodeCursor = (c: { year: number; offset: number }): string =>
  `${c.year}:${c.offset}`;

// ── Search API types ─────────────────────────────────────

/**
 * One row of the DMS index, under the keys the service itself uses.
 *
 * Every corpus this endpoint serves answers with the same key set and fills
 * a different part of it, so a key that is null on every decision sampled is
 * still declared here: it is the collection or the archive that fills it,
 * and a row of either reaches this type through the same reader.
 *
 * Two keys are typed against what the service sends rather than against
 * what the key's name suggests. `mkDifferentView` is a single value from a
 * three-entry vocabulary, and `mkTypeOfProposer` is one value on a decision
 * and several on an archived one.
 *
 * The service answers every key on every row and sends `null` for the ones
 * a corpus leaves empty, so each value is nullable as well as optional. The
 * three keys that are one value on some rows and several on others are
 * `unknown` here: nothing upstream validates them, and only
 * {@link publisherList} may read them.
 */
type SearchDocumentFields = {
  documentId: string;
  docType: string;
  title: string;
  content: string;
  index: number;
  extension: string;
  size: number;
  contentType: string;
  mkDocumentType: string;
  mkRSAPNumberOfFile: string;
  mkRVPNumberOfFile: string;
  mkECLI: string;
  mkDateOfDecision: string;
  mkDateOfLegalForce: string;
  mkPublicationDate: string;
  mkFormOfDecision: string;
  mkTypeOfDecision: string[];
  mkTypeOfProceeding: string;
  mkTypeOfNegotiation: string[];
  mkDecisionInTermsOf: string[];
  mkDecisionInTermsOfForSort: string;
  mkResultOfNegotiation: string[];
  mkCause: string[];
  mkJudgeReporter: string;
  mkDifferentView: string;
  mkWordRegister: string[];
  mkMaterialRegister: string[];
  mkComplainedLegalRegulation: unknown;
  mkClarificationOfLegalRegulation: unknown;
  mkFileReference: string[];
  mkReferences: string[];
  mkTypeOfProposer: unknown;
  mkAffectedLegalRegulation: string;
  mkUnderage: string;
  mkIncludeToZnaU: boolean;
  mkEntryDate: string;
  mkFormOfEntry: string;
  mkTypeOfEntry: string;
  mkParentIdDecision: string;
  mkLawReportsNumber: string | number;
  mkVolumeOfLawReports: string | number;
  mkYearOfLawReports: number;
  mkTimePeriodZNaU: string;
  mkClauseTitle: string;
  mkClauseText: string;
  mkWebTitle: string;
};

type SearchDocument = {
  [Key in keyof SearchDocumentFields]?: SearchDocumentFields[Key] | null;
};

type SearchResponse = {
  documents: SearchDocument[];
  numFound: number;
};

/**
 * Validate only the response envelope. Individual document
 * field validation is too brittle: the Liferay DMS API adds
 * fields and changes types without notice (e.g. returning
 * USSR_DECISION alongside USSR_DECISION_MK items). Since all
 * metadata lands in JSONB, strict per-field validation adds
 * no safety — it just causes the entire page to be rejected.
 */
const isSearchResponse = (value: unknown): value is SearchResponse =>
  isRecord(value) &&
  Array.isArray(value["documents"]) &&
  value["documents"].every(isRecord) &&
  typeof value["numFound"] === "number";

// ── Date parsing ─────────────────────────────────────────

/**
 * Parse the API's date format "MM/DD/YYYY HH:mm:ss" to
 * ISO "YYYY-MM-DD".
 */
const parseApiDate = (raw: string | null | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const groups = /^(?<month>\d{2})\/(?<day>\d{2})\/(?<year>\d{4})/u.exec(
    raw,
  )?.groups;
  if (!groups?.["month"] || !groups["day"] || !groups["year"]) {
    return undefined;
  }
  return `${groups["year"]}-${groups["month"]}-${groups["day"]}`;
};

// ── PDF download ─────────────────────────────────────────

/** Every PDF starts with this; nothing else the portal serves does. */
const PDF_SIGNATURE = "%PDF-";

const PDF_SIGNATURE_BYTES = new TextEncoder().encode(PDF_SIGNATURE);

/** A per-decision read (the PDF, or a response the build needs) that failed. */
const detailReadFailed = failureSink({
  event: "case_law.ingestion.detail_fetch_failed",
  expected: [],
});

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_SIGNATURE_BYTES.length &&
  PDF_SIGNATURE_BYTES.every((byte, index) => bytes[index] === byte);

/** What one read of a decision's PDF established. */
type SkUsPdfRead =
  | { type: "pdf"; bytes: Uint8Array }
  /** The court stated no document, or served something that is not a PDF. */
  | { type: "not-served"; evidence: AbsenceEvidence | "not-a-pdf" }
  | ReadRefusal
  | { type: "unavailable"; cause: ReadUnavailableCause };

type ReadFailureErrorOptions = {
  url: string;
  cause: ReadUnavailableCause;
  label: string;
};

/**
 * A failed read as an error, with its status where it had one, for
 * telemetry and for the retry, authentication and stop-kind checks that read
 * it.
 */
const readFailureError = ({
  url,
  cause,
  label,
}: ReadFailureErrorOptions): Error => {
  switch (cause.kind) {
    case "thrown":
      return cause.error instanceof Error
        ? cause.error
        : new FetchBoundaryError({ url, message: label, cause: cause.error });
    case "status":
    case "no-content":
    case "empty-body":
      return new FetchBoundaryError({
        url,
        status: cause.status,
        message: `${label}: ${cause.status}`,
      });
    case "too-large":
      return new FetchBoundaryError({
        url,
        message: `${label}: body over ${cause.maxBytes} bytes`,
      });
    default:
      cause satisfies never;
      return panic(`Unhandled read cause: ${String(cause)}`);
  }
};

/**
 * The decision's PDF, or why there is none.
 *
 * The status alone does not answer that: this portal answers a document
 * request with a 200 error page, and those bytes taken on faith would be
 * stored as the decision's raw payload under `application/pdf` — an
 * unparseable blob every later re-parse would read as the document itself.
 * Checking the signature is what makes "the court served something else" and
 * "the court served a PDF this parser cannot read" different answers: only the
 * second is a payload worth keeping.
 */
const fetchPdfBytes = async (
  documentId: string,
  signal?: AbortSignal,
): Promise<SkUsPdfRead> => {
  const read = await readPublisherBytes(`${DOC_DOWNLOAD_URL}/${documentId}`, {
    fetchStage: "document",
    adapterKey: ADAPTER_KEYS.SK_US,
    expectedContentType: "pdf",
    headers: { "User-Agent": INGESTION_USER_AGENT },
    signal,
    timeoutMs: 30_000,
  });
  // The failed download is reported, graded as the upstream being
  // unavailable, so an unreachable portal is told apart from documents it
  // does not serve.
  const unavailable = (cause: ReadUnavailableCause): SkUsPdfRead => {
    observeFailure(
      classifyFailure(
        readFailureError({
          url: DOC_DOWNLOAD_URL,
          cause,
          label: "SK ÚS PDF download failed",
        }),
        "upstream_unavailable",
      ),
      {
        sink: detailReadFailed,
        ctx: { adapterKey: ADAPTER_KEYS.SK_US, documentId },
      },
    );
    return { type: "unavailable", cause };
  };
  // A served but empty body, one over the read ceiling, and one that fails
  // after the headers are failed reads, not a page the court answered with in
  // place of a document: the read types all three as unavailable.
  switch (read.type) {
    case "present":
      return isPdf(read.value)
        ? { type: "pdf", bytes: read.value }
        : { type: "not-served", evidence: "not-a-pdf" };
    case "absent":
      return { type: "not-served", evidence: read.evidence };
    case "refused":
      return read;
    case "unavailable":
      return unavailable(read.cause);
    default:
      read satisfies never;
      return panic(`Unhandled PDF read: ${String(read)}`);
  }
};

// ── The other responses served for one decision ──────────

/**
 * One JSON response from the service, typed by what the read established.
 *
 * Only a 404 or 410 states that a surface holds nothing for this decision;
 * an empty 204, a 500 or an empty body is a read that failed. A 401, 403 or
 * 451 is a refusal of what `refusalScope` names.
 */
const readJson = async (
  path: string,
  init: {
    body?: string;
    signal?: AbortSignal;
    fetchStage: DocumentFetchStage;
    refusalScope: ReadRefusalScope;
  },
): Promise<ReadOutcome<string>> =>
  await readPublisherText(`${SERVICE_URL}/${path}`, {
    fetchStage: init.fetchStage,
    adapterKey: ADAPTER_KEYS.SK_US,
    refusalScope: init.refusalScope,
    ...(init.body === undefined ? {} : { method: "POST", body: init.body }),
    headers: {
      "User-Agent": INGESTION_USER_AGENT,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });

/**
 * The decision's text, as the service renders it.
 *
 * The response wraps one field, a base64 XHTML document, and the document
 * is what the envelope keeps: the wrapper is transport, and storing the
 * encoding would put a third of the bytes into stating that it is base64.
 */
const fetchDocumentXhtml = async (
  documentId: string,
  signal?: AbortSignal,
): Promise<ReadOutcome<string>> => {
  const read = await readJson(CONTENT_PATH, {
    body: JSON.stringify({
      highlightText: "",
      documentId,
      docType: DECISION_DOC_TYPE,
    }),
    fetchStage: "document",
    refusalScope: "document",
    ...(signal === undefined ? {} : { signal }),
  });
  if (read.type !== "present") {
    return read;
  }
  const payload: unknown = Result.try({
    try: (): unknown => JSON.parse(read.value),
    catch: () => null,
  }).unwrapOr(null);
  const content = isRecord(payload) ? payload["content"] : undefined;
  if (typeof content !== "string") {
    return readUnavailable({
      kind: "thrown",
      error: new FetchBoundaryError({
        url: `${SERVICE_URL}/${CONTENT_PATH}`,
        message: "SK ÚS content response has no document",
      }),
    });
  }
  // The document states its own charset; read the bytes as that, not as
  // UTF-8 by assumption.
  return readPresent(
    decodeDeclared(Buffer.from(content, "base64"), { contentType: null }).text,
  );
};

/**
 * The index-only fields, read as facet counts over one docket on one day.
 *
 * A facet counts values across a result set, so what it says belongs to
 * whatever the query selected. Narrowed to a docket and the day it was
 * decided, the result set is that docket's documents on that day: the
 * decision and the separate opinions filed with it. That is the level these
 * fields are true at anyway — a dissent belongs to the docket's decision,
 * and the index does not say which of the docket's documents carries the
 * name. A narrower query is not available: the service filters on the
 * docket, the ECLI and the register number, and a separate opinion has no
 * ECLI of its own.
 */
const fetchFacets = async (
  { caseNumber, decisionDate }: { caseNumber: string; decisionDate: string },
  signal?: AbortSignal,
): Promise<ReadOutcome<string>> =>
  await readJson(SEARCH_PATH, {
    fetchStage: "listing",
    refusalScope: "part",
    body: JSON.stringify({
      docType: DECISION_DOC_TYPE,
      start: 0,
      pageSize: PAGE_SIZE,
      searchFilter: {
        filterNameValue: [
          {
            type: "DATE_RANGE",
            fieldName: "mkDateOfDecision",
            fieldValue: { FROM: decisionDate, TO: decisionDate },
          },
          {
            type: "STRING",
            fieldName: "mkRSAPNumberOfFileNorm",
            fieldValue: caseNumber,
          },
        ],
      },
      facetFilter: { facetFilterNameValue: [] },
      facets: FACET_FIELDS,
      fieldsToReturn: FIELDS_TO_RETURN,
      clustering: false,
    }),
    ...(signal === undefined ? {} : { signal }),
  });

/** Collection entries have their own document ids; a docket query does not re-key them. */
const fetchCollectionListing = async (
  { caseNumber, decisionDate }: { caseNumber: string; decisionDate: string },
  signal?: AbortSignal,
): Promise<ReadOutcome<string>> =>
  await readJson(SEARCH_PATH, {
    fetchStage: "listing",
    refusalScope: "part",
    body: JSON.stringify({
      docType: COLLECTION_DOC_TYPE,
      start: 0,
      pageSize: LISTING_PAGE_SIZE,
      searchFilter: {
        filterNameValue: [
          {
            type: "DATE_RANGE",
            fieldName: "mkDateOfDecision",
            fieldValue: { FROM: decisionDate, TO: decisionDate },
          },
          {
            type: "STRING",
            fieldName: "mkRSAPNumberOfFileNorm",
            fieldValue: caseNumber,
          },
        ],
      },
      facetFilter: { facetFilterNameValue: [] },
      facets: [],
      fieldsToReturn: FIELDS_TO_RETURN,
      clustering: false,
    }),
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * The docket file a decision was filed under, with the documents in it.
 *
 * Addressed by the register number with its first separator replaced, which
 * is the address the portal itself builds. It is the only surface stating
 * when the petition reached the court and what other files it refers to.
 */
const fetchCourtFile = async (
  rvpNumber: string,
  signal?: AbortSignal,
): Promise<ReadOutcome<string>> =>
  await readJson(`${COURT_FILE_PATH}/${rvpNumber.replace("/", ":")}`, {
    fetchStage: "document",
    refusalScope: "part",
    ...(signal === undefined ? {} : { signal }),
  });

/** The vocabularies the coded fields resolve against, whole. */
type SkUsCodelist = {
  /** Digest of the response the values below were read out of. */
  sha256: string;
  values: Readonly<Record<(typeof JUDGE_CODELISTS)[number], readonly string[]>>;
};

const parseCodelist = (body: string): SkUsCodelist | undefined => {
  const payload: unknown = Result.try({
    try: (): unknown => JSON.parse(body),
    catch: () => null,
  }).unwrapOr(null);
  const codelist = isRecord(payload) ? payload["codelist"] : undefined;
  if (!isRecord(codelist)) {
    return undefined;
  }
  const roster = (name: (typeof JUDGE_CODELISTS)[number]): string[] => {
    const entries = codelist[name];
    return Array.isArray(entries)
      ? entries.filter((entry): entry is string => typeof entry === "string")
      : [];
  };
  return {
    sha256: hashContent(body),
    values: {
      mkJudgeReporter: roster("mkJudgeReporter"),
      mkDifferentViewJudges: roster("mkDifferentViewJudges"),
    },
  };
};

/**
 * What one decision's envelope keeps of the vocabularies.
 *
 * The response is corpus-level and two hundred kilobytes; a row per
 * decision holding all of it would store the same list fifty thousand
 * times. So the envelope keeps the digest of the response that was read and
 * the entries this decision's own judge fields matched in it, which is what
 * a later reader needs to ask whether a name was in the roster at the time.
 */
type SkUsCodelistPart = {
  sha256: string;
  used: Record<string, readonly string[]>;
};

const codelistPart = (
  codelist: SkUsCodelist,
  named: Readonly<Record<(typeof JUDGE_CODELISTS)[number], readonly string[]>>,
): SkUsCodelistPart => ({
  sha256: codelist.sha256,
  used: Object.fromEntries(
    JUDGE_CODELISTS.map((name) => [
      name,
      named[name].filter((value) => codelist.values[name].includes(value)),
    ]),
  ),
});

/**
 * The responses a page of decisions shares, fetched once for the page.
 *
 * The vocabularies are the same for every decision in a crawl, and a
 * docket's documents are listed together and read one after another, so
 * both would otherwise be re-requested per document. Held per call rather
 * than per process: a cache that outlived a cycle would state a roster the
 * court has since added a judge to.
 */
export type SkUsPageContext = {
  collectionListing: (
    key: { caseNumber: string; decisionDate: string },
    signal?: AbortSignal,
  ) => Promise<ReadOutcome<string>>;
  codelist: (signal?: AbortSignal) => Promise<ReadOutcome<SkUsCodelist>>;
  facets: (
    key: { caseNumber: string; decisionDate: string },
    signal?: AbortSignal,
  ) => Promise<ReadOutcome<string>>;
  courtFile: (
    rvpNumber: string,
    signal?: AbortSignal,
  ) => Promise<ReadOutcome<string>>;
};

/** Joins a docket and a date into one cache key; neither ever contains it. */
const FACET_KEY_SEPARATOR = "|";

/** Memoize one asynchronous read per key, including the reads that answer nothing. */
const perKey = <T>(
  read: (key: string, signal?: AbortSignal) => Promise<T>,
): ((key: string, signal?: AbortSignal) => Promise<T>) => {
  const inFlight = new Map<string, Promise<T>>();
  return async (key, signal) => {
    const held = inFlight.get(key);
    if (held !== undefined) {
      return await held;
    }
    const started = read(key, signal);
    inFlight.set(key, started);
    return await started;
  };
};

export const createSkUsPageContext = (): SkUsPageContext => {
  const codelist = perKey(
    async (_key, signal): Promise<ReadOutcome<SkUsCodelist>> => {
      const read = await readJson(CODELIST_PATH, {
        fetchStage: "listing",
        refusalScope: "part",
        ...(signal === undefined ? {} : { signal }),
      });
      if (read.type !== "present") {
        return read;
      }
      const parsed = parseCodelist(read.value);
      return parsed === undefined
        ? readUnavailable({
            kind: "thrown",
            error: new FetchBoundaryError({
              url: `${SERVICE_URL}/${CODELIST_PATH}`,
              message: "SK ÚS codelist response has no codelist",
            }),
          })
        : readPresent(parsed);
    },
  );
  const facets = perKey(async (key, signal) => {
    const [caseNumber = "", decisionDate = ""] = key.split(FACET_KEY_SEPARATOR);
    return await fetchFacets({ caseNumber, decisionDate }, signal);
  });
  const collectionListing = perKey(async (key, signal) => {
    const [caseNumber = "", decisionDate = ""] = key.split(FACET_KEY_SEPARATOR);
    return await fetchCollectionListing({ caseNumber, decisionDate }, signal);
  });
  const courtFile = perKey(
    async (key, signal) => await fetchCourtFile(key, signal),
  );

  return {
    collectionListing: async ({ caseNumber, decisionDate }, signal) =>
      await collectionListing(
        `${caseNumber}${FACET_KEY_SEPARATOR}${decisionDate}`,
        signal,
      ),
    codelist: async (signal) => await codelist("decision", signal),
    facets: async ({ caseNumber, decisionDate }, signal) =>
      await facets(
        `${caseNumber}${FACET_KEY_SEPARATOR}${decisionDate}`,
        signal,
      ),
    courtFile: async (rvpNumber, signal) => await courtFile(rvpNumber, signal),
  };
};

// ── Item parsing ─────────────────────────────────────────

/** The values of one facet, as the service counts them. */
const facetValues = (
  facetsJson: string | undefined,
  field: FacetField,
): string[] => {
  if (facetsJson === undefined) {
    return [];
  }
  const payload: unknown = Result.try({
    try: (): unknown => JSON.parse(facetsJson),
    catch: () => null,
  }).unwrapOr(null);
  const counts = isRecord(payload) ? payload["facetCount"] : undefined;
  const field_ = isRecord(counts) ? counts[field] : undefined;
  return isRecord(field_) ? Object.keys(field_) : [];
};

/** The header row of a docket file, which is the document typed as the file. */
const courtFileHeader = (
  fileJson: string | undefined,
): SearchDocument | undefined => {
  if (fileJson === undefined) {
    return undefined;
  }
  const payload: unknown = Result.try({
    try: (): unknown => JSON.parse(fileJson),
    catch: () => null,
  }).unwrapOr(null);
  const documents = isRecord(payload) ? payload["documents"] : undefined;
  if (!Array.isArray(documents)) {
    return undefined;
  }
  return documents.find(
    (document): document is SearchDocument =>
      isRecord(document) && document["docType"] === "USSR_COURTFILE",
  );
};

/** The keys the service sends as one value on a decision and several on an archived one. */
type PublisherListField =
  | "mkComplainedLegalRegulation"
  | "mkClarificationOfLegalRegulation"
  | "mkTypeOfProposer";

/**
 * One of those keys as a list. Absent and `null` are the service stating no
 * value; any shape other than a string or a list of strings is refused as the
 * field it is, rather than left to a spread that throws a bare `TypeError`.
 */
const publisherList = (
  doc: SearchDocument,
  field: PublisherListField,
): string[] => {
  const value = doc[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (isUnknownArray(value) && value.every(isString)) {
    return [...value];
  }
  throw new UnpersistableDecisionFieldError({
    message: `SK ÚS ${field} is neither a value nor a list of values`,
    field: UNPERSISTABLE_DECISION_FIELDS.VALUE_LIST,
  });
};

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The two fields an item must state for this adapter to keep it: the docket it
 * is stored under and the id its document is downloaded by. Stated once,
 * because the crawl, the identity rule and the listing walk must agree exactly
 * on which items exist — an item one of them keeps and another drops is either
 * a decision nothing ever stores or a slice that can never be filled.
 */
const skUsIdentityFields = (
  doc: SearchDocument,
): { caseNumber: string; documentId: string } | null => {
  const { documentId, mkRSAPNumberOfFile: caseNumber } = doc;
  if (
    typeof caseNumber !== "string" ||
    caseNumber.length === 0 ||
    typeof documentId !== "string" ||
    // The id is now the stored identity, so one the column cannot hold is not
    // a document this adapter can key: keeping it would hunt a row nothing can
    // ever write.
    !isPersistableSourceDocumentId(documentId)
  ) {
    return null;
  }
  return { caseNumber, documentId };
};

/**
 * The identity the ingest would store for this listing item.
 *
 * The DMS `documentId`, which is what the publisher itself keys a document on:
 * the court publishes each opinion of a plenary decision as its own document
 * under one docket (19 documents under `PL. ÚS 4/2020` in March 2020 alone),
 * so a `(caseNumber, language)` key names a docket rather than a document and
 * collapses all of them onto one row.
 *
 * {@link buildSkUsDecision} stores that same id as `sourceDocumentId`, and
 * rows written before it did are re-keyed by the deterministic
 * `docDownload/{id}` URL they carry — see `legacySourceUrls` there. The two
 * must state one rule: a walk that keyed items differently from the ingest
 * would read stored decisions as missing and re-fetch them forever.
 */
export const skUsListingIdentity = (doc: SearchDocument): ListingIdentity => {
  const fields = skUsIdentityFields(doc);
  return fields === null
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId: fields.documentId };
};

export type SkUsListingFetchOutcome =
  | { type: "listing"; listing: string }
  | { type: "listing_unavailable" }
  | { type: "listing_identity_mismatch" }
  | { type: "publisher_rate_limited"; error: AdapterFetchError }
  | { type: "retry_later"; error: AdapterFetchError };

/** A search request that established no listing. */
type SearchReadFailure = Exclude<ReadOutcome<string>, { type: "present" }>;

/** The status an HTTP absence was stated with. */
const absenceStatus = (evidence: AbsenceEvidence): number => {
  switch (evidence) {
    case "http-404":
      return 404;
    case "http-410":
      return 410;
    case "stated-zero":
    case "publisher-typed-absence":
      return panic(
        `A publisher request stated a non-HTTP absence: ${evidence}`,
      );
    default:
      evidence satisfies never;
      return panic(`Unhandled absence evidence: ${String(evidence)}`);
  }
};

type SearchReadFailureOptions = {
  read: SearchReadFailure;
  url: string;
  label: string;
};

/**
 * What a failed search request stands for, with its status, so the retry
 * and authentication checks read it. A 404 from the search endpoint is the
 * endpoint failing, not a decision absence.
 */
const searchReadFailure = ({
  read,
  url,
  label,
}: SearchReadFailureOptions): Error => {
  switch (read.type) {
    case "absent": {
      const status = absenceStatus(read.evidence);
      return new FetchBoundaryError({
        url,
        status,
        message: `${label}: ${status}`,
      });
    }
    case "refused":
      return new FetchBoundaryError({
        url,
        status: read.status,
        message: `${label}: ${read.status}`,
      });
    case "unavailable":
      return readFailureError({ url, cause: read.cause, label });
    default:
      read satisfies never;
      return panic(`Unhandled search read: ${String(read)}`);
  }
};

type FetchSkUsListingOptions = {
  documentId: string;
  caseNumber: string;
  signal?: AbortSignal;
  read?: typeof readPublisherText;
  pause?: (milliseconds: number) => Promise<void>;
};

/** Refetch only the publisher row, using the crawl's gated HTTP boundary. */
// parser-output-unchanged: listing fetch only; stored replay and parser inputs are unchanged.
export const fetchSkUsListing = async ({
  documentId,
  caseNumber,
  signal,
  read = readPublisherText,
  pause = async (milliseconds) => {
    await Bun.sleep(milliseconds);
  },
}: FetchSkUsListingOptions): Promise<SkUsListingFetchOutcome> => {
  for (let attempt = 0; ; attempt += 1) {
    const fetched = await Result.tryPromise({
      try: async (): Promise<SkUsListingFetchOutcome> => {
        const listed = await read(SEARCH_URL, {
          adapterKey: ADAPTER_KEYS.SK_US,
          fetchStage: "listing",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": INGESTION_USER_AGENT,
          },
          body: JSON.stringify({
            docType: DECISION_DOC_TYPE,
            start: 0,
            pageSize: 2,
            searchFilter: {
              filterNameValue: [
                {
                  type: "STRING",
                  fieldName: "documentId",
                  fieldValue: documentId,
                },
              ],
            },
            facetFilter: { facetFilterNameValue: [] },
            facets: [],
            fieldsToReturn: FIELDS_TO_RETURN,
            clustering: false,
          }),
          signal,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        });
        if (
          listed.type === "unavailable" &&
          listed.cause.kind === "no-content"
        ) {
          return { type: "listing_unavailable" };
        }
        if (listed.type !== "present") {
          throw searchReadFailure({
            read: listed,
            url: SEARCH_URL,
            label: "SK ÚS listing fetch failed",
          });
        }
        const data: unknown = JSON.parse(listed.value);
        if (!isSearchResponse(data)) {
          throw new FetchBoundaryError({
            url: SEARCH_URL,
            message: "SK ÚS listing response has an invalid shape",
          });
        }
        if (data.numFound === 0 && data.documents.length === 0) {
          return { type: "listing_unavailable" };
        }
        const doc = data.documents.at(0);
        const identity = doc === undefined ? null : skUsIdentityFields(doc);
        if (
          data.numFound !== 1 ||
          data.documents.length !== 1 ||
          identity?.documentId !== documentId ||
          identity.caseNumber !== caseNumber
        ) {
          return { type: "listing_identity_mismatch" };
        }
        return { type: "listing", listing: JSON.stringify(doc) };
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_US, null),
    });
    if (Result.isOk(fetched)) {
      return fetched.value;
    }
    // The publisher's rate-limit refusal arrives as readPublisher's typed
    // stop (rule 19a): one request, no retry.
    if (fetched.error.httpStatus === 429) {
      return { type: "publisher_rate_limited", error: fetched.error };
    }
    const cause = fetched.error.cause;
    const retryable =
      cause instanceof FetchBoundaryError &&
      cause.status !== undefined &&
      cause.status >= 500;
    if (attempt >= 2 || signal?.aborted || !retryable) {
      return { type: "retry_later", error: fetched.error };
    }
    await pause(
      backoffDelay(attempt, {
        baseMs: 1000,
        maxMs: 30_000,
        jitter: { type: "additive", random: Math.random(), rangeMs: 1000 },
      }),
    );
  }
};

/**
 * What building one listed item produced.
 *
 * `detail-unavailable` still carries the decision the listing alone describes,
 * because the two callers dispose of it differently: the crawl's cursor moves
 * past this document either way, so a listing-only row is worth more to it
 * than nothing, while the reconciliation must refuse it — a detail-less row
 * would make the identity held and take the document out of every later
 * reconciliation.
 */
export type SkUsBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No docket or no document id to key on; nothing can store this item. */
  | { type: "unkeyable" }
  /** The court served no document for the id the listing states. */
  | { type: "detail-unavailable"; decision: IngestionResult }
  /**
   * A response the decision is built from was unavailable, or the document
   * was refused. `item` is the listing-only row of every response read so
   * far; the pipeline decides what it costs the page.
   */
  | { type: "unread"; part: SkUsReadPart; item: UnreadListedItem };

/**
 * States, as plain text the reconciliation walk can select on, that a row was
 * built without a part the service refused. It is written beside the typed
 * refusal and from the same value, and is gone once a build reads the part.
 */
const SK_US_PART_READ_METADATA_KEY = "partReadState";

const SK_US_PART_READ_STATE = { WITHHELD: "withheld" } as const;

/** The per-decision responses a build cannot do without once requested. */
type SkUsReadPart =
  | "codelist"
  | "document"
  | "facets"
  | "collection-listing"
  | "file"
  | "document-file";

type SkUsPartRead<T> =
  | { type: "read"; value: T | undefined }
  /** A part the service refused: built without it, the refusal typed. */
  | { type: "withheld"; refusal: ReadRefusal }
  /** A read that stops the build: unavailable, or the document refused. */
  | { type: "unread"; outcome: UnreadOutcome };

/**
 * One per-decision read as a build input: the value, `undefined` where the
 * service stated it holds none, a refused part, or the outcome that stops
 * the build.
 */
const partRead = <T>(read: ReadOutcome<T>): SkUsPartRead<T> => {
  switch (read.type) {
    case "present":
      return { type: "read", value: read.value };
    case "absent":
      return { type: "read", value: undefined };
    case "refused":
      return read.scope === "part"
        ? { type: "withheld", refusal: read }
        : { type: "unread", outcome: read };
    case "unavailable":
      return { type: "unread", outcome: read };
    default:
      read satisfies never;
      return panic(`Unhandled SK ÚS read: ${String(read)}`);
  }
};

export type BuildSkUsDecisionOptions = {
  /**
   * The responses this page has already fetched. A caller building one
   * decision on its own may omit it and pay for its own.
   */
  context?: SkUsPageContext | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * The judges this decision's own record names, in the two roles the service
 * states structurally.
 *
 * The rapporteur is a field on the row. The dissenters are an index field
 * the row never carries, counted per docket by the facet query; the court
 * also names the author in the first line of the opinion's own text, and
 * that prose is deliberately not read here, because a roster field the
 * publisher maintains is a better answer than a sentence parsed out of a
 * document.
 */
const skUsJudges = ({
  rapporteurs,
  dissenters,
}: {
  rapporteurs: readonly string[];
  dissenters: readonly string[];
}): DecisionJudgeInput[] =>
  [
    ...rapporteurs.map((nameAsPrinted) => ({
      role: DECISION_JUDGE_ROLE.RAPPORTEUR,
      nameAsPrinted,
    })),
    ...dissenters.map((nameAsPrinted) => ({
      role: DECISION_JUDGE_ROLE.DISSENTING,
      nameAsPrinted,
    })),
  ].filter(({ nameAsPrinted }) => nameAsPrinted.trim().length > 0);

/** The rapporteur the row names; the service sends `null` on a row without one. */
const skUsRapporteurs = (doc: SearchDocument): string[] =>
  typeof doc.mkJudgeReporter === "string" ? [doc.mkJudgeReporter] : [];

/**
 * The court's own statement that a collection entry has no legal sentence.
 *
 * Printed in place of the text rather than left blank, so it is an answer
 * and not an absence: a reader that stored it as the sentence would publish
 * the words "no legal sentence" as the court's holding.
 */
const NO_LEGAL_SENTENCE = "- bez právnej vety -";

const skUsTextFields = (
  doc: SearchDocument,
): RawIngestionResult["textFields"] => {
  const absent = absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED);
  const headnote = doc.mkClauseTitle?.trim();
  const legalSentence = doc.mkClauseText?.trim();
  const fields = {
    ...absent,
    ...(headnote === undefined || headnote.length === 0
      ? {}
      : { headnote: { type: "present" as const, text: headnote } }),
  };
  if (legalSentence === NO_LEGAL_SENTENCE) {
    return {
      ...fields,
      legalSentence: {
        type: "absent",
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      },
    };
  }
  if (legalSentence === undefined || legalSentence.length === 0) {
    return fields;
  }
  return {
    ...fields,
    legalSentence: { type: "present", text: legalSentence },
  };
};

type SkUsCollectionMatch =
  | { status: "matched"; entry: SearchDocument }
  | {
      status: "unresolved";
      reason:
        | "unavailable"
        | "invalid_listing"
        | "incomplete_listing"
        | "no_matching_entry"
        | "ambiguous_identity";
    };

const storedSearchResponse = (
  raw: string | undefined,
): SearchResponse | null => {
  if (raw === undefined) {
    return null;
  }
  const value: unknown = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  return isSearchResponse(value) ? value : null;
};

// Preserve unknown publisher fields while validating everything the join reads.
const COLLECTION_ENTRY_SCHEMA = v.looseObject({
  docType: v.literal(COLLECTION_DOC_TYPE),
  documentId: v.pipe(v.string(), v.minLength(1)),
  mkRSAPNumberOfFile: v.string(),
  mkDateOfDecision: v.exactOptional(v.nullable(v.string())),
  mkFormOfDecision: v.exactOptional(v.nullable(v.string())),
  mkTypeOfDecision: v.exactOptional(v.nullable(v.array(v.string()))),
  mkClauseTitle: v.exactOptional(v.nullable(v.string())),
  mkClauseText: v.exactOptional(v.nullable(v.string())),
  mkLawReportsNumber: v.exactOptional(
    v.nullable(v.union([v.string(), v.number()])),
  ),
  mkVolumeOfLawReports: v.exactOptional(
    v.nullable(v.union([v.string(), v.number()])),
  ),
  mkYearOfLawReports: v.exactOptional(
    v.nullable(v.pipe(v.number(), v.integer())),
  ),
  mkTimePeriodZNaU: v.exactOptional(v.nullable(v.string())),
});

type SkUsCollectionMatchOptions = {
  doc: SearchDocument;
  collectionJson: string | undefined;
  facetsJson: string | undefined;
};

/** A docket can contain several judgments and opinions, so both sides must be unique. */
const skUsCollectionMatch = ({
  doc,
  collectionJson,
  facetsJson,
}: SkUsCollectionMatchOptions): SkUsCollectionMatch => {
  const collection = storedSearchResponse(collectionJson);
  if (collection === null) {
    return { status: "unresolved", reason: "unavailable" };
  }
  const validated = v.safeParse(
    v.array(COLLECTION_ENTRY_SCHEMA),
    collection.documents,
  );
  if (
    !validated.success ||
    !Number.isSafeInteger(collection.numFound) ||
    collection.numFound < 0
  ) {
    return { status: "unresolved", reason: "invalid_listing" };
  }
  if (collection.numFound !== collection.documents.length) {
    return { status: "unresolved", reason: "incomplete_listing" };
  }
  const date = parseApiDate(doc.mkDateOfDecision);
  const kind = doc.mkFormOfDecision?.toLocaleLowerCase("sk");
  const sameDecision = (entry: SearchDocument): boolean => {
    if (
      date === undefined ||
      kind === undefined ||
      entry.mkRSAPNumberOfFile !== doc.mkRSAPNumberOfFile ||
      parseApiDate(entry.mkDateOfDecision) !== date
    ) {
      return false;
    }
    if (typeof entry.mkFormOfDecision === "string") {
      return entry.mkFormOfDecision.toLocaleLowerCase("sk") === kind;
    }
    return (
      Array.isArray(entry.mkTypeOfDecision) &&
      entry.mkTypeOfDecision.some(
        (value) =>
          typeof value === "string" && value.toLocaleLowerCase("sk") === kind,
      )
    );
  };
  const entries = validated.output.filter(sameDecision);
  const entry = entries.at(0);
  if (entry === undefined) {
    return { status: "unresolved", reason: "no_matching_entry" };
  }
  if (entries.length !== 1) {
    return { status: "unresolved", reason: "ambiguous_identity" };
  }
  const siblings = storedSearchResponse(facetsJson);
  if (siblings === null || siblings.numFound !== siblings.documents.length) {
    return { status: "unresolved", reason: "incomplete_listing" };
  }
  const decisions = siblings.documents.filter(sameDecision);
  if (
    decisions.length !== 1 ||
    decisions.at(0)?.documentId !== doc.documentId
  ) {
    return { status: "unresolved", reason: "ambiguous_identity" };
  }
  return { status: "matched", entry };
};

type SkUsCollectionPublication =
  | {
      status: "published";
      documentId: string | null;
      number: string | number | null;
      volume: string | number | null;
      year: number | null;
      period: string | null;
    }
  | {
      status: "selected" | "not_included" | "not_stated";
      reason: Extract<SkUsCollectionMatch, { status: "unresolved" }>["reason"];
    };

const skUsCollectionPublication = (
  doc: SearchDocument,
  collection: SkUsCollectionMatch,
): SkUsCollectionPublication => {
  switch (collection.status) {
    case "matched": {
      const { entry } = collection;
      return {
        status: "published",
        documentId: entry.documentId ?? null,
        number: entry.mkLawReportsNumber ?? null,
        volume: entry.mkVolumeOfLawReports ?? null,
        year: entry.mkYearOfLawReports ?? null,
        period: entry.mkTimePeriodZNaU ?? null,
      };
    }
    case "unresolved":
      if (doc.mkIncludeToZnaU === true) {
        return { status: "selected", reason: collection.reason };
      }
      if (doc.mkIncludeToZnaU === false) {
        return { status: "not_included", reason: collection.reason };
      }
      return { status: "not_stated", reason: collection.reason };
    default:
      collection satisfies never;
      return panic("Unhandled ÚS collection identity state");
  }
};

const skUsCollectionTextFields = (
  doc: SearchDocument,
  collection: SkUsCollectionMatch,
): RawIngestionResult["textFields"] => {
  const stated = skUsTextFields(doc);
  switch (collection.status) {
    case "unresolved":
      return stated;
    case "matched": {
      const published = skUsTextFields(collection.entry);
      return {
        ...stated,
        headnote:
          stated.headnote.type !== "present" &&
          published.headnote.type === "present"
            ? published.headnote
            : stated.headnote,
        legalSentence:
          stated.legalSentence.type !== "present" &&
          published.legalSentence.type === "present"
            ? published.legalSentence
            : stated.legalSentence,
      };
    }
    default:
      collection satisfies never;
      return panic("Unhandled ÚS collection identity state");
  }
};

const skUsEcliAvailability = (doc: SearchDocument): SkUsEcliAvailability => {
  if (!Object.hasOwn(doc, "mkECLI")) {
    return { status: "not_stated" };
  }
  return doc.mkECLI ? { status: "published" } : { status: "not_published" };
};

type SkUsMetadataOptions = {
  doc: SearchDocument;
  facetsJson: string | undefined;
  /** The docket file's own header row, where the service served one. */
  header: SearchDocument | undefined;
  collection: SkUsCollectionMatch;
};

/**
 * Every field the stored responses state, under the name this row keeps it.
 *
 * Two are renamed at the boundary. The service calls them `mkWordRegister`
 * and `mkMaterialRegister`, and prints them as `Predmet konania` (what the
 * proceedings were about) and `Vecný register` (the subject index) — which
 * is the opposite of what the key names suggest, so the row spells what the
 * court prints.
 */
const skUsMetadata = ({
  doc,
  facetsJson,
  header,
  collection,
}: SkUsMetadataOptions): Record<string, unknown> => {
  const multiValueMetadata = {
    typeOfDecision: doc.mkTypeOfDecision,
    typeOfNegotiation: doc.mkTypeOfNegotiation,
    legalBasis: doc.mkDecisionInTermsOf,
    result: doc.mkResultOfNegotiation,
    cause: doc.mkCause,
    proceedingSubject: doc.mkWordRegister,
    subjectIndex: doc.mkMaterialRegister,
    challengedLegislation: publisherList(doc, "mkComplainedLegalRegulation"),
    clarificationOfLegalRegulation: publisherList(
      doc,
      "mkClarificationOfLegalRegulation",
    ),
    typeOfProposer: publisherList(doc, "mkTypeOfProposer"),
    defendant: facetValues(facetsJson, "mkDefendant"),
    publicDefendant: facetValues(facetsJson, "mkPublicDefendant"),
    violator: facetValues(facetsJson, "mkViolator"),
    formOfProposer: facetValues(facetsJson, "mkFormOfProposer"),
    kindOfOtherProposer: facetValues(facetsJson, "mkKindOfOtherProposer"),
    defendantProceedingFileNumber: facetValues(
      facetsJson,
      "mkFileNumberOfDefendantProceeding",
    ),
  };
  const normalizedValues = Object.fromEntries(
    Object.entries(multiValueMetadata).map(([key, values]) => [
      key,
      normalizeMetadataValues(values),
    ]),
  );
  return {
    ...multiValueMetadata,
    normalizedValues,
    caseNumber: doc.mkRSAPNumberOfFile,
    ecli: doc.mkECLI,
    decisionType: doc.mkFormOfDecision,
    decisionTypeKey: decisionTypeKey(doc.mkFormOfDecision),
    documentId: doc.documentId,
    docType: doc.docType,
    title: doc.title,
    contentType: doc.contentType,
    documentType: doc.mkDocumentType,
    rvpNumber: doc.mkRVPNumberOfFile,
    typeOfProceeding: doc.mkTypeOfProceeding,
    dissentingOpinion: doc.mkDifferentView,
    legalForceDate: parseApiDate(doc.mkDateOfLegalForce),
    publicationDate: parseApiDate(doc.mkPublicationDate),
    fileReference: doc.mkFileReference,
    affectedLegalRegulation: doc.mkAffectedLegalRegulation,
    underage: doc.mkUnderage,
    includeToZnaU: doc.mkIncludeToZnaU,
    publishedInCollection: skUsCollectionPublication(doc, collection),
    ...(collection.status === "matched"
      ? { collectionEntry: collection.entry }
      : {}),
    ecliAvailability: skUsEcliAvailability(doc),
    formOfEntry: doc.mkFormOfEntry,
    typeOfEntry: doc.mkTypeOfEntry,
    parentDecisionKind: doc.mkParentIdDecision,
    lawReportsNumber: doc.mkLawReportsNumber,
    volumeOfLawReports: doc.mkVolumeOfLawReports,
    yearOfLawReports: doc.mkYearOfLawReports,
    collectionPeriod: doc.mkTimePeriodZNaU,
    webTitle: doc.mkWebTitle,
    // The docket file answers the two the decision row leaves empty: when the
    // petition arrived, and what other files this one refers to.
    entryDate: parseApiDate(doc.mkEntryDate ?? header?.mkEntryDate),
    references: doc.mkReferences ?? header?.mkReferences,
    courtFileId: header?.documentId,
  };
};

/** Every response one decision's build has read, and the part it withheld. */
type SkUsResponses = {
  codelist: SkUsCodelist | undefined;
  documentXhtml: string | undefined;
  facetsJson: string | undefined;
  collectionJson: string | undefined;
  courtFileJson: string | undefined;
  pdfBytes: Uint8Array | undefined;
  /**
   * The first part the service refused, stored typed under the read-outcome
   * key on the decision built without it.
   */
  withheld: ReadRefusal | undefined;
};

type AssembleSkUsDecisionOptions = {
  doc: SearchDocument;
  caseNumber: string;
  documentId: string;
  responses: Readonly<SkUsResponses>;
};

/**
 * The decision the responses read so far describe. Without the document
 * file it is the listing-only row a later read completes.
 */
const assembleSkUsDecision = ({
  doc,
  caseNumber,
  documentId,
  responses: {
    codelist,
    documentXhtml,
    facetsJson,
    collectionJson,
    courtFileJson,
    pdfBytes,
    withheld,
  },
}: AssembleSkUsDecisionOptions): IngestionResult => {
  const decisionDate = parseApiDate(doc.mkDateOfDecision);
  const decisionType = doc.mkFormOfDecision ?? undefined;
  const ecli = doc.mkECLI ?? undefined;
  const court = "Ústavný súd SR";
  const documentUrl = `${DOC_DOWNLOAD_URL}/${documentId}`;
  const collection = skUsCollectionMatch({ doc, collectionJson, facetsJson });
  const rapporteurs = skUsRapporteurs(doc);
  const dissenters = facetValues(facetsJson, "mkDifferentViewJudges");

  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let fulltext: string | undefined;

  if (documentXhtml !== undefined) {
    try {
      const parsed = parseSkUsDocumentXhtml({
        xhtml: documentXhtml,
        caseNumber,
        ecli,
        court,
        decisionDate,
        decisionType,
        documentUrl,
      });
      documentAst = parsed.documentAst;
      fulltext = parsed.fulltext;
    } catch (error) {
      // The document itself is in the envelope, so its text is recoverable
      // by re-parsing what was kept rather than by asking the court again.
      // Reported rather than swallowed: a parser that starts failing across
      // a whole page is otherwise indistinguishable from decisions that
      // genuinely carry no text.
      logDocumentParseFailure({
        adapterKey: ADAPTER_KEYS.SK_US,
        caseNumber,
        error: errorTag(error),
      });
    }
  }

  const header = courtFileHeader(courtFileJson);

  const parts: Record<string, string> = {
    listing: JSON.stringify(doc),
    ...(collectionJson === undefined
      ? {}
      : { "collection-listing": collectionJson }),
    ...(documentXhtml === undefined ? {} : { document: documentXhtml }),
    ...(facetsJson === undefined ? {} : { facets: facetsJson }),
    ...(courtFileJson === undefined ? {} : { file: courtFileJson }),
    ...(codelist === undefined
      ? {}
      : {
          codelists: JSON.stringify(
            codelistPart(codelist, {
              mkJudgeReporter: rapporteurs,
              mkDifferentViewJudges: dissenters,
            }),
          ),
        }),
    // The service's answer to the part it withheld. Kept so the fingerprint
    // tells a refused part from one stated absent, which otherwise store the
    // same responses: a row stored either way is rewritten when that changes.
    ...(withheld === undefined ? {} : { refusal: JSON.stringify(withheld) }),
  };
  const sourceRaw = encodeSourceRawEnvelope(parts);
  const sourceRawObjects =
    pdfBytes === undefined
      ? undefined
      : {
          "document-file": {
            bytes: pdfBytes,
            contentType: "application/pdf",
          },
        };

  const decision: IngestionResult = plainTextIngestionResult({
    caseNumber,
    sourceDocumentId: documentId,
    // What every row this adapter wrote before it stated an id was stored
    // under: one row per docket, carrying the download URL of whichever of the
    // docket's documents was written last. The URL names one document exactly,
    // so it re-keys that row to the document it was built from instead of
    // inserting a second one beside it; the docket's other documents find no
    // null-id row and are inserted, which is the collapse being undone.
    legacySourceUrls: [documentUrl],
    ecli,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_US].country,
    language: SK_US_LANGUAGE,
    decisionDate,
    decisionType,
    fulltext,
    judges: skUsJudges({ rapporteurs, dissenters }),
    // The listing proves the document exists; without its file this row
    // carries the metadata and the text, and must never overwrite detail a
    // later fetch recovered.
    ...(pdfBytes === undefined ? { isListingOnly: true } : {}),
    sourceUrl: documentUrl,
    documentUrl,
    textFields: skUsCollectionTextFields(doc, collection),
    metadata: checkedDecisionMetadata({
      ...skUsMetadata({ doc, facetsJson, header, collection }),
      ...(withheld === undefined
        ? {}
        : {
            [READ_OUTCOME_METADATA_KEY]: withheld,
            [SK_US_PART_READ_METADATA_KEY]: SK_US_PART_READ_STATE.WITHHELD,
          }),
    }),
    rawHash: sourceFingerprint({ sourceRaw, sourceRawObjects }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_US],
    documentAst,
    sourceRaw,
    // The file the court serves is binary, so the envelope names it rather
    // than holding it; the pipeline writes it and fills in the address.
    ...(sourceRawObjects === undefined ? {} : { sourceRawObjects }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });

  return decision;
};

/**
 * Build one decision from a search-listing item, fetching every other
 * response the service serves for it. Shared by the crawl and the
 * reconciliation walk so neither can key, parse or enrich an item
 * differently from the other.
 *
 * Four requests per document: the text, the facet counts the index-only
 * fields are stated as, the docket file, and the document file itself. Two
 * of them are shared within a page, so a docket's separate opinions cost
 * the text and the file only.
 */
export const buildSkUsDecision = async (
  doc: SearchDocument,
  { context, signal }: BuildSkUsDecisionOptions = {},
): Promise<SkUsBuildResult> => {
  const fields = skUsIdentityFields(doc);
  if (fields === null) {
    return { type: "unkeyable" };
  }
  const { caseNumber, documentId } = fields;
  const page = context ?? createSkUsPageContext();

  const decisionDate = parseApiDate(doc.mkDateOfDecision);

  const responses: SkUsResponses = {
    codelist: undefined,
    documentXhtml: undefined,
    facetsJson: undefined,
    collectionJson: undefined,
    courtFileJson: undefined,
    pdfBytes: undefined,
    withheld: undefined,
  };
  /** Take one read into the build; the outcome that stops it, if any. */
  const take = <T>(
    read: SkUsPartRead<T>,
    store: (value: T | undefined) => void,
  ): UnreadOutcome | undefined => {
    switch (read.type) {
      case "read":
        store(read.value);
        return undefined;
      case "withheld":
        responses.withheld ??= read.refusal;
        return undefined;
      case "unread":
        return read.outcome;
      default:
        read satisfies never;
        return panic(`Unhandled SK ÚS part read: ${String(read)}`);
    }
  };
  const unread = (
    part: SkUsReadPart,
    outcome: UnreadOutcome,
  ): SkUsBuildResult => ({
    type: "unread",
    part,
    item: {
      listing: {
        ...assembleSkUsDecision({ doc, caseNumber, documentId, responses }),
        sourceDocumentId: documentId,
        isListingOnly: true,
      },
      outcome,
    },
  });

  // The page's vocabularies, shared by every decision on it: a refusal
  // withholds them as a part, an unavailable read leaves each item unread.
  const codelistStop = take(partRead(await page.codelist(signal)), (value) => {
    responses.codelist = value;
  });
  if (codelistStop !== undefined) {
    return unread("codelist", codelistStop);
  }
  const documentStop = take(
    partRead(await fetchDocumentXhtml(documentId, signal)),
    (value) => {
      responses.documentXhtml = value;
    },
  );
  if (documentStop !== undefined) {
    return unread("document", documentStop);
  }
  if (decisionDate !== undefined) {
    const facetsStop = take(
      partRead(await page.facets({ caseNumber, decisionDate }, signal)),
      (value) => {
        responses.facetsJson = value;
      },
    );
    if (facetsStop !== undefined) {
      return unread("facets", facetsStop);
    }
    const collectionStop = take(
      partRead(
        await page.collectionListing({ caseNumber, decisionDate }, signal),
      ),
      (value) => {
        responses.collectionJson = value;
      },
    );
    if (collectionStop !== undefined) {
      return unread("collection-listing", collectionStop);
    }
  }
  signal?.throwIfAborted();
  const rvpNumber = doc.mkRVPNumberOfFile ?? undefined;
  if (rvpNumber !== undefined) {
    const fileStop = take(
      partRead(await page.courtFile(rvpNumber, signal)),
      (value) => {
        responses.courtFileJson = value;
      },
    );
    if (fileStop !== undefined) {
      return unread("file", fileStop);
    }
  }
  // Last: the most expensive read, worth paying only once every other
  // response is in hand.
  const pdf = await fetchPdfBytes(documentId, signal);
  switch (pdf.type) {
    case "pdf":
      responses.pdfBytes = pdf.bytes;
      break;
    // Where the court states there is no document, the row is held
    // listing-only, which the reconciliation asks about again.
    case "not-served":
      break;
    case "refused":
      return unread("document-file", pdf);
    case "unavailable":
      return unread("document-file", { type: "unavailable", cause: pdf.cause });
    default:
      pdf satisfies never;
      return panic(`Unhandled SK ÚS PDF read: ${String(pdf)}`);
  }

  const decision = assembleSkUsDecision({
    doc,
    caseNumber,
    documentId,
    responses,
  });
  return responses.pdfBytes === undefined
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

// ── Search helper ───────────────────────────────────────

/** HTTP statuses that mean "authenticate", which this adapter cannot. */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

const isAuthFailure = (error: unknown): boolean =>
  error instanceof FetchBoundaryError &&
  error.status !== undefined &&
  AUTH_FAILURE_STATUSES.has(error.status);

/**
 * A closed decision-date window, `YYYY-MM-DD` on both ends, as the DMS
 * `DATE_RANGE` filter states it. The crawl windows by year to stay under the
 * endpoint's internal pagination cap; the reconciliation windows by month.
 */
type SearchDateRange = { from: string; to: string };

type ExecuteSearchOptions = {
  offset: number;
  pageSize: number;
  range: SearchDateRange;
  signal?: AbortSignal | undefined;
};

type SearchRead =
  | { type: "present"; data: SearchResponse }
  | { type: "absent"; data: SearchResponse }
  | { type: "unavailable" };

const executeSearch = async ({
  offset,
  pageSize,
  range,
  signal,
}: ExecuteSearchOptions): Promise<SearchRead> => {
  const read = await readPublisherText(SEARCH_URL, {
    fetchStage: "listing",
    adapterKey: ADAPTER_KEYS.SK_US,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": INGESTION_USER_AGENT,
    },
    body: JSON.stringify({
      docType: "USSR_DECISION_MK",
      start: offset,
      pageSize,
      searchFilter: {
        filterNameValue: [
          {
            type: "DATE_RANGE",
            fieldName: "mkDateOfDecision",
            fieldValue: {
              FROM: range.from,
              TO: range.to,
            },
          },
        ],
      },
      facetFilter: { facetFilterNameValue: [] },
      facets: [],
      fieldsToReturn: FIELDS_TO_RETURN,
      clustering: false,
    }),
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });

  if (read.type === "unavailable" && read.cause.kind === "no-content") {
    return { type: "unavailable" };
  }
  if (read.type !== "present") {
    // A 401/403 here means the court put the endpoint back behind
    // authentication. There is no credential to refresh — the adapter
    // needs a real one — so surface it rather than retrying blind.
    throw searchReadFailure({
      read,
      url: SEARCH_URL,
      label: "SK ÚS search failed",
    });
  }

  const data: unknown = JSON.parse(read.value);
  if (!isSearchResponse(data)) {
    const preview = JSON.stringify(data).slice(0, 200);
    panic(`SK ÚS search returned an invalid payload: ${preview}`);
  }

  return data.documents.length === 0
    ? { type: "absent", data }
    : { type: "present", data };
};

type ExecuteSearchWithRetryOptions = ExecuteSearchOptions & {
  cursor: string | null;
};

const executeSearchWithRetry = async ({
  cursor,
  offset,
  pageSize,
  range,
  signal,
}: ExecuteSearchWithRetryOptions) =>
  await Result.tryPromise(
    {
      try: async ({ signal: attemptSignal }) => {
        if (attemptSignal?.aborted) {
          throw new DOMException("Cycle aborted", "AbortError");
        }
        return await executeSearch({
          offset,
          pageSize,
          range,
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
        });
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_US, cursor),
    },
    {
      ...(signal ? { signal } : {}),
      retry: {
        times: 1,
        delayMs: SEARCH_RETRY_DELAY_MS,
        backoff: "constant",
        shouldRetry: (error) =>
          !(error.cause instanceof DOMException) && !isAuthFailure(error.cause),
      },
    },
  );

// ── Reconciliation ───────────────────────────────────────

/**
 * A reconciliation slice is one calendar month of decision dates, `YYYY-MM`,
 * which sorts lexicographically in chronological order — the ordering the
 * ledger relies on.
 *
 * The month rather than the year, even though the crawl windows by year: the
 * DMS honours an arbitrary `DATE_RANGE`, and a year is too coarse to walk
 * safely. The endpoint caps pagination at roughly 3,000 results per query, and
 * the recent years are already close to it (2,454 decisions in 2020, 361 in
 * June 2026 alone), so a year slice would silently stop listing the moment the
 * court has a busy enough year — and a slice that cannot be listed to the end
 * is a slice the ledger can never call complete. A month is a few hundred
 * decisions, four pages of {@link LISTING_PAGE_SIZE}.
 *
 * The day, which would be finer still, is the wrong unit in the other
 * direction: the court sits in panels on a handful of days a month, so most
 * days are empty and the walk would spend its requests proving that.
 */
export const SK_US_FIRST_SLICE = `${FIRST_YEAR}-01`;

/**
 * Slices near the tip that get re-walked on a fast cadence. The contract
 * counts slices, not days, so for this adapter the window is six months: a
 * decision is listed only once the court has released it, this API states no
 * publication date to measure that lag from (`mkPublicationDate` and
 * `mkEntryDate` come back empty on current-year items), and a slice outside
 * the window is re-walked only if the ledger already recorded it short. Six
 * months of half-yearly-lagged releases is generous, and still a smaller fast
 * lane than a day-sliced source's fortnight.
 */
const SK_US_TIP_WINDOW_SLICES = 6;

const SLICE_PATTERN = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u;

type SliceMonth = { year: number; month: number };

const parseSlice = (slice: string): SliceMonth => {
  const groups = SLICE_PATTERN.exec(slice)?.groups;
  if (!groups?.["year"] || !groups["month"]) {
    panic(`sk-us slice is not a calendar month: ${slice}`);
  }
  return {
    year: Number.parseInt(groups["year"], 10),
    month: Number.parseInt(groups["month"], 10),
  };
};

const formatSlice = ({ month, year }: SliceMonth): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

const skUsSliceOf = (now: Date): string => {
  const day = Temporal.Instant.fromEpochMilliseconds(
    now.getTime(),
  ).toZonedDateTimeISO("UTC");
  return formatSlice({ year: day.year, month: day.month });
};

/** Step a slice by whole months, normalizing the year through UTC. */
const stepSlice = (slice: string, months: number): string => {
  const { month, year } = parseSlice(slice);
  return Temporal.PlainYearMonth.from({ year, month })
    .add({ months })
    .toString();
};

const skUsNextSlice = (slice: string): string | null => {
  const next = stepSlice(slice, 1);
  return next > skUsSliceOf(new Date()) ? null : next;
};

const skUsPreviousSlice = (slice: string): string | null => {
  const previous = stepSlice(slice, -1);
  return previous < SK_US_FIRST_SLICE ? null : previous;
};

/** The publisher's own filter bounds for a slice: the month, end to end. */
const sliceDateRange = (slice: string): SearchDateRange => {
  const { month, year } = parseSlice(slice);
  const lastDay = Temporal.PlainYearMonth.from({ year, month }).daysInMonth;
  return { from: `${slice}-01`, to: `${slice}-${String(lastDay)}` };
};

/**
 * One listed item for a result the DMS will not serve.
 *
 * With no body there is no document id and no docket, so there is nothing to
 * key the decision on and nothing that could be invented: an identity guessed
 * from the offset would name a row the ingest can never write. The engine
 * counts an item like this as unidentifiable and leaves it out of both
 * `reported` and `collected`, which is what lets the month settle on the
 * records that do exist instead of standing one short of a number no walk can
 * reach.
 */
const unservedListingItem = (offset: number): ReconciliationListingItem => ({
  identity: { type: "unidentifiable" },
  payload: { unservedResultIndex: offset },
});

/** What one window of a date range's results answered. */
type ListedWindow = {
  items: (
    | { type: "served"; document: SearchDocument }
    | { type: "unserved"; offset: number }
  )[];
  /** The range's size, from whichever sub-window stated it; null if none did. */
  numFound: number | null;
};

/**
 * Requests one unservable record costs to isolate: the endpoint answers each
 * halving twice, once for the half that carries the record and once for the
 * half that does not.
 */
const SPLIT_REQUESTS_PER_UNSERVED_RECORD =
  2 * Math.ceil(Math.log2(LISTING_PAGE_SIZE));

/**
 * Extra requests one page may spend isolating what the DMS refuses.
 *
 * Two records' worth. A page needing more than that is not a page with a
 * poisoned record on it, and spending a full binary subdivision (2·pageSize-1
 * requests) to establish that would be a worse answer than leaving the slice
 * its previous ledger row.
 */
const SPLIT_REQUEST_BUDGET = 2 * SPLIT_REQUESTS_PER_UNSERVED_RECORD;

/** Extra requests a page's splitting may still spend. */
type SplitBudget = { remaining: number };

type ListSkUsWindowOptions = {
  budget: SplitBudget;
  /** 0-indexed result offset within the date range. */
  offset: number;
  pageSize: number;
  range: SearchDateRange;
  slice: string;
  signal?: AbortSignal | undefined;
};

const unservedWindowError = (
  slice: string,
  detail: string,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `SK ÚS search returned no body for ${slice}: ${detail}`,
    adapterKey: ADAPTER_KEYS.SK_US,
    cursor: slice,
  });

type SearchWindowOptions = Omit<ListSkUsWindowOptions, "budget">;

/** One typed reading of a publisher search window. */
const searchWindow = async ({
  offset,
  pageSize,
  range,
  signal,
  slice,
}: SearchWindowOptions): Promise<SearchRead> => {
  const searchResult = await executeSearchWithRetry({
    cursor: slice,
    offset,
    pageSize,
    range,
    signal,
  });
  if (Result.isError(searchResult)) {
    throw searchResult.error;
  }
  return searchResult.value;
};

const listedWindow = (data: SearchResponse): ListedWindow => ({
  items: data.documents.map((document) => ({ type: "served", document })),
  numFound: data.numFound,
});

/**
 * List one crawl-year or reconciliation-month window, isolating DMS refusals.
 *
 * The endpoint answers 204 with an empty body for any window containing a
 * record it cannot serialise, and it does so deterministically: for 2025-04,
 * `start=194&pageSize=1` answered 204 while 193 and 195 answered 200, and
 * every wider window covering 194 answered 204 too. One such record therefore
 * refuses the whole page it falls on, and a page read as an outage held the
 * slice for an hour, every hour, with no pass ever able to get past it.
 *
 * So a refused window is halved until the refusal is one record wide. What
 * surrounds it lists normally, the record itself is reported with nothing to
 * key on, and the month settles honestly: 277 reported, 277 collected, one
 * unidentifiable. The halving terminates at a window of one record, costs up to
 * {@link SPLIT_REQUESTS_PER_UNSERVED_RECORD} plus the one confirming request
 * below per such record, and each of those requests waits the same pause as
 * every other request here.
 *
 * A refused subtree may have no count, including adjacent poison records;
 * a sibling can still supply the count for the enclosing page. If the whole
 * page serves nothing, it cannot distinguish poison records from an empty
 * range. Reconciliation rejects it; the crawl records the refusal and parks
 * its current frontier with bounded polling. The shared split budget bounds
 * that work.
 *
 * A one-record refusal is confirmed by a second request before it is reported
 * unserved. An unidentifiable item is excluded from the slice rather than
 * parked, so nothing retries it later: a single 204 taken at face value would
 * drop a real decision out of `reported` permanently, and this endpoint is
 * known to answer badly under load. One request is a reading; two agreeing
 * requests are a property of the record.
 */
const listSkUsWindow = async ({
  budget,
  offset,
  pageSize,
  range,
  signal,
  slice,
}: ListSkUsWindowOptions): Promise<ListedWindow> => {
  const data = await searchWindow({ offset, pageSize, range, signal, slice });
  if (data.type !== "unavailable") {
    return listedWindow(data.data);
  }

  if (pageSize <= 1) {
    const confirmation = await searchWindow({
      offset,
      pageSize,
      range,
      signal,
      slice,
    });
    return confirmation.type === "unavailable"
      ? { items: [{ type: "unserved", offset }], numFound: null }
      : listedWindow(confirmation.data);
  }

  if (budget.remaining < 2) {
    throw unservedWindowError(
      slice,
      `splitting a refused window at offset ${offset} spent its ${SPLIT_REQUEST_BUDGET}-request budget`,
    );
  }
  budget.remaining -= 2;

  const half = Math.ceil(pageSize / 2);
  const lower = await listSkUsWindow({
    budget,
    offset,
    pageSize: half,
    range,
    signal,
    slice,
  });
  const upper = await listSkUsWindow({
    budget,
    offset: offset + half,
    pageSize: pageSize - half,
    range,
    signal,
    slice,
  });

  // Both halves state the size of the same range, so two different counts mean
  // the range changed under the walk or the endpoint answered about something
  // else. Either way the page cannot be sized, and banking it would write a
  // `reported` the slice can never reach.
  if (
    lower.numFound !== null &&
    upper.numFound !== null &&
    lower.numFound !== upper.numFound
  ) {
    throw new AdapterFetchError({
      message: `SK ÚS search sized ${slice} as ${lower.numFound} and ${upper.numFound} while splitting ${pageSize} records from offset ${offset}`,
      adapterKey: ADAPTER_KEYS.SK_US,
      cursor: slice,
    });
  }

  const numFound = lower.numFound ?? upper.numFound;

  return { items: [...lower.items, ...upper.items], numFound };
};

const listSkUsSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const { items, numFound } = await listSkUsWindow({
    budget: { remaining: SPLIT_REQUEST_BUDGET },
    offset: page * LISTING_PAGE_SIZE,
    pageSize: LISTING_PAGE_SIZE,
    range: sliceDateRange(slice),
    signal,
    slice,
  });

  if (numFound === null) {
    // A window with no served records cannot establish the publisher count.
    throw unservedWindowError(slice, `offset ${page * LISTING_PAGE_SIZE}`);
  }

  return {
    items: items.map((item) => {
      switch (item.type) {
        case "served":
          return {
            identity: skUsListingIdentity(item.document),
            payload: item.document,
          };
        case "unserved":
          return unservedListingItem(item.offset);
        default:
          item satisfies never;
          return panic("Unhandled SK ÚS listing result");
      }
    }),
    totalPages: Math.ceil(numFound / LISTING_PAGE_SIZE),
  };
};

/**
 * Validate a payload the loop stored verbatim well enough to key it.
 *
 * Deliberately as lenient as {@link isSearchResponse}, and for the same
 * reason: the DMS adds fields and changes their types without notice, and all
 * of it lands in JSONB. Only the two fields the identity is made of are
 * checked, so a parked payload that no longer states them is reported rather
 * than parsed on faith.
 */
const isSearchDocument = (value: unknown): value is SearchDocument =>
  isRecord(value) &&
  (value["documentId"] === undefined ||
    typeof value["documentId"] === "string") &&
  (value["mkRSAPNumberOfFile"] === undefined ||
    typeof value["mkRSAPNumberOfFile"] === "string");

const buildSkUsFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isSearchDocument(payload)) {
    return { type: "unkeyable" };
  }
  const built = await buildSkUsDecision(payload, {
    ...(signal === undefined ? {} : { signal }),
  });
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    case "detail-unavailable":
    case "unread":
      // The decision the listing describes is deliberately dropped: storing it
      // would make the identity held while its document stayed unread.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled SK ÚS build result: ${String(built)}`);
    }
  }
};

// ── Source fields ────────────────────────────────────────

/**
 * Every field this service states for one decision, under its own key.
 *
 * Three responses state fields, and the union of their keys is this list.
 * The search row carries the same forty-six keys for every corpus the
 * endpoint serves, filling a different part of them per corpus. The facet
 * query states seven more that no projection ever carries. The
 * vocabularies state no field of their own: they are the values two of the
 * keys above are drawn from, so they resolve under those keys rather than
 * beside them.
 */
const SK_US_SOURCE_FIELDS_LIST = [
  "documentId",
  "docType",
  "title",
  "content",
  "index",
  "extension",
  "size",
  "contentType",
  "mkDocumentType",
  "mkRSAPNumberOfFile",
  "mkRVPNumberOfFile",
  "mkECLI",
  "mkDateOfDecision",
  "mkDateOfLegalForce",
  "mkPublicationDate",
  "mkFormOfDecision",
  "mkTypeOfDecision",
  "mkTypeOfProceeding",
  "mkTypeOfNegotiation",
  "mkDecisionInTermsOf",
  "mkDecisionInTermsOfForSort",
  "mkResultOfNegotiation",
  "mkCause",
  "mkJudgeReporter",
  "mkDifferentView",
  "mkWordRegister",
  "mkMaterialRegister",
  "mkComplainedLegalRegulation",
  "mkClarificationOfLegalRegulation",
  "mkFileReference",
  "mkReferences",
  "mkTypeOfProposer",
  "mkAffectedLegalRegulation",
  "mkUnderage",
  "mkIncludeToZnaU",
  "mkEntryDate",
  "mkFormOfEntry",
  "mkTypeOfEntry",
  "mkParentIdDecision",
  "mkLawReportsNumber",
  "mkVolumeOfLawReports",
  "mkYearOfLawReports",
  "mkTimePeriodZNaU",
  "mkClauseTitle",
  "mkClauseText",
  "mkWebTitle",
  ...FACET_FIELDS,
] as const;

type SkUsSourceField = (typeof SK_US_SOURCE_FIELDS_LIST)[number];

const SK_US_SOURCE_FIELDS = {
  documentId: { disposition: "stored", target: { type: "identity" } },
  docType: {
    disposition: "stored",
    target: { type: "metadata", key: "docType" },
  },
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  content: excludedSourceField(
    "always empty in a search row; the document body is served by an endpoint of its own and kept as the document part",
  ),
  index: excludedSourceField(
    "the row's offset inside the page it arrived on, which changes with the page and states nothing about the document",
  ),
  extension: excludedSourceField(
    "empty on every record of every corpus this endpoint serves",
  ),
  size: excludedSourceField(
    "empty on every record of every corpus this endpoint serves",
  ),
  contentType: {
    disposition: "stored",
    target: { type: "metadata", key: "contentType" },
  },
  mkDocumentType: {
    disposition: "stored",
    target: { type: "metadata", key: "documentType" },
  },
  mkRSAPNumberOfFile: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  mkRVPNumberOfFile: {
    disposition: "stored",
    target: { type: "metadata", key: "rvpNumber" },
  },
  mkECLI: { disposition: "stored", target: { type: "result", key: "ecli" } },
  mkDateOfDecision: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  mkDateOfLegalForce: {
    disposition: "stored",
    target: { type: "metadata", key: "legalForceDate" },
  },
  mkPublicationDate: {
    disposition: "stored",
    target: { type: "metadata", key: "publicationDate" },
  },
  mkFormOfDecision: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  mkTypeOfDecision: {
    disposition: "stored",
    target: { type: "metadata", key: "typeOfDecision" },
  },
  mkTypeOfProceeding: {
    disposition: "stored",
    target: { type: "metadata", key: "typeOfProceeding" },
  },
  mkTypeOfNegotiation: {
    disposition: "stored",
    target: { type: "metadata", key: "typeOfNegotiation" },
  },
  mkDecisionInTermsOf: {
    disposition: "stored",
    target: { type: "metadata", key: "legalBasis" },
  },
  mkDecisionInTermsOfForSort: excludedSourceField(
    "a sort projection of the basis field: the same values flattened into one string",
  ),
  mkResultOfNegotiation: {
    disposition: "stored",
    target: { type: "metadata", key: "result" },
  },
  mkCause: {
    disposition: "stored",
    target: { type: "metadata", key: "cause" },
  },
  mkJudgeReporter: {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  mkDifferentView: {
    disposition: "stored",
    target: { type: "metadata", key: "dissentingOpinion" },
  },
  mkWordRegister: {
    disposition: "stored",
    target: { type: "metadata", key: "proceedingSubject" },
  },
  mkMaterialRegister: {
    disposition: "stored",
    target: { type: "metadata", key: "subjectIndex" },
  },
  mkComplainedLegalRegulation: {
    disposition: "stored",
    target: { type: "metadata", key: "challengedLegislation" },
  },
  mkClarificationOfLegalRegulation: {
    disposition: "stored",
    target: { type: "metadata", key: "clarificationOfLegalRegulation" },
  },
  mkFileReference: {
    disposition: "stored",
    target: { type: "metadata", key: "fileReference" },
  },
  mkReferences: {
    disposition: "stored",
    target: { type: "metadata", key: "references" },
  },
  mkTypeOfProposer: {
    disposition: "stored",
    target: { type: "metadata", key: "typeOfProposer" },
  },
  mkAffectedLegalRegulation: {
    disposition: "stored",
    target: { type: "metadata", key: "affectedLegalRegulation" },
  },
  mkUnderage: {
    disposition: "stored",
    target: { type: "metadata", key: "underage" },
  },
  mkIncludeToZnaU: {
    disposition: "stored",
    target: { type: "metadata", key: "includeToZnaU" },
  },
  mkEntryDate: {
    disposition: "stored",
    target: { type: "metadata", key: "entryDate" },
  },
  mkFormOfEntry: {
    disposition: "stored",
    target: { type: "metadata", key: "formOfEntry" },
  },
  mkTypeOfEntry: {
    disposition: "stored",
    target: { type: "metadata", key: "typeOfEntry" },
  },
  mkParentIdDecision: {
    disposition: "stored",
    target: { type: "metadata", key: "parentDecisionKind" },
  },
  mkLawReportsNumber: {
    disposition: "stored",
    target: { type: "metadata", key: "lawReportsNumber" },
  },
  mkVolumeOfLawReports: {
    disposition: "stored",
    target: { type: "metadata", key: "volumeOfLawReports" },
  },
  mkYearOfLawReports: {
    disposition: "stored",
    target: { type: "metadata", key: "yearOfLawReports" },
  },
  mkTimePeriodZNaU: {
    disposition: "stored",
    target: { type: "metadata", key: "collectionPeriod" },
  },
  mkClauseTitle: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  mkClauseText: {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  mkWebTitle: {
    disposition: "stored",
    target: { type: "metadata", key: "webTitle" },
  },
  mkDifferentViewJudges: {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  mkDefendant: {
    disposition: "stored",
    target: { type: "metadata", key: "defendant" },
  },
  mkPublicDefendant: {
    disposition: "stored",
    target: { type: "metadata", key: "publicDefendant" },
  },
  mkViolator: {
    disposition: "stored",
    target: { type: "metadata", key: "violator" },
  },
  mkFormOfProposer: {
    disposition: "stored",
    target: { type: "metadata", key: "formOfProposer" },
  },
  mkKindOfOtherProposer: {
    disposition: "stored",
    target: { type: "metadata", key: "kindOfOtherProposer" },
  },
  mkFileNumberOfDefendantProceeding: {
    disposition: "stored",
    target: { type: "metadata", key: "defendantProceedingFileNumber" },
  },
} as const satisfies Record<SkUsSourceField, SourceFieldDisposition>;

/**
 * Read back the field names the stored envelope states.
 *
 * Driven from the parts rather than from the list above, so a key the
 * service starts sending reaches the conformance suite as an undeclared
 * field instead of as silence. The document part states no named field at
 * all: it is the decision's own prose, and the parts that label anything
 * are the three read here.
 */
const listSkUsSourceFields = (parts: SourceRawParts): readonly string[] => {
  const names = new Set<string>();

  const listing: unknown = Result.try({
    try: (): unknown => JSON.parse(parts["listing"] ?? "null"),
    catch: () => null,
  }).unwrapOr(null);
  if (isRecord(listing)) {
    for (const name of Object.keys(listing)) {
      names.add(name);
    }
  }

  const collection = storedSearchResponse(parts["collection-listing"]);
  if (collection !== null) {
    for (const entry of collection.documents) {
      for (const name of Object.keys(entry)) {
        names.add(name);
      }
    }
  }

  const facets: unknown = Result.try({
    try: (): unknown => JSON.parse(parts["facets"] ?? "null"),
    catch: () => null,
  }).unwrapOr(null);
  const facetCount = isRecord(facets) ? facets["facetCount"] : undefined;
  if (isRecord(facetCount)) {
    for (const name of Object.keys(facetCount)) {
      names.add(name);
    }
  }

  // The vocabularies resolve two of the names above; the part states which
  // ones were read, and a vocabulary nothing was read from states nothing.
  const codelists: unknown = Result.try({
    try: (): unknown => JSON.parse(parts["codelists"] ?? "null"),
    catch: () => null,
  }).unwrapOr(null);
  const used = isRecord(codelists) ? codelists["used"] : undefined;
  if (isRecord(used)) {
    for (const [name, values] of Object.entries(used)) {
      if (Array.isArray(values) && values.length > 0) {
        names.add(name);
      }
    }
  }

  return [...names];
};

// ── Re-parsing a stored envelope ─────────────────────────

const SK_US_REPARSABLE_CONTENT_TYPES = new Set([
  "application/json",
  "application/pdf",
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
]);

/**
 * Read both the envelope and the two shapes stored before it.
 *
 * Rows written before this adapter had an envelope hold either the search
 * row alone, as JSON, or the document file alone, as its bytes. The second
 * is why a legacy row can carry no listing at all: the pipeline stored
 * whichever of the two the adapter set last, and the file won.
 */
export const skUsStoredRawParts = (
  raw: string,
  contentType: string | null,
): SourceRawParts | null => {
  const envelope = decodeSourceRawEnvelope(raw);
  if (envelope !== null) {
    return envelope;
  }
  if (contentType === "application/pdf") {
    // The bytes are the document file, which this adapter no longer parses
    // and cannot rebuild a row from; naming the part is what lets a reader
    // say so rather than guess at the payload.
    return { "document-file": raw };
  }
  if (contentType !== "application/json" && contentType !== null) {
    return null;
  }
  const parsed: unknown = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  return isRecord(parsed) ? { listing: raw } : null;
};

/**
 * Rebuild one decision from its stored responses alone.
 *
 * The listing part is what a row is rebuilt from, and the document part is
 * what its text comes from, so a legacy row holding only the document file
 * is refused: its metadata was never stored, and inventing it from the
 * database row would write a decision the publisher never stated.
 */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !SK_US_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }

  const raw = new TextDecoder().decode(stored.raw);
  const parts = skUsStoredRawParts(raw, stored.contentType);
  const listingJson = parts?.["listing"];
  if (listingJson === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `no search row in the stored payload for ${stored.caseNumber}`,
    };
  }
  const listing: unknown = Result.try({
    try: (): unknown => JSON.parse(listingJson),
    catch: () => null,
  }).unwrapOr(null);
  if (!isSearchDocument(listing)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `the stored search row for ${stored.caseNumber} states no identity`,
    };
  }

  const fields = skUsIdentityFields(listing);
  if (fields === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `the stored search row for ${stored.caseNumber} states no identity`,
    };
  }
  if (fields.caseNumber !== stored.caseNumber) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored payload states ${fields.caseNumber}`,
    };
  }

  const decisionDate = parseApiDate(listing.mkDateOfDecision);
  const decisionType = listing.mkFormOfDecision ?? undefined;
  const court = stored.court;
  const documentUrl = `${DOC_DOWNLOAD_URL}/${fields.documentId}`;
  const documentXhtml = parts?.["document"];
  const facetsJson = parts?.["facets"];
  const collection = skUsCollectionMatch({
    doc: listing,
    collectionJson: parts?.["collection-listing"],
    facetsJson,
  });

  const parsed =
    documentXhtml === undefined
      ? null
      : parseSkUsDocumentXhtml({
          xhtml: documentXhtml,
          caseNumber: fields.caseNumber,
          ecli: listing.mkECLI ?? undefined,
          court,
          decisionDate,
          decisionType,
          documentUrl,
        });

  return {
    type: "parsed",
    result: plainTextIngestionResult({
      caseNumber: fields.caseNumber,
      sourceDocumentId: fields.documentId,
      ecli: listing.mkECLI ?? undefined,
      court,
      country: ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_US].country,
      language: SK_US_LANGUAGE,
      decisionDate,
      decisionType,
      ...(parsed === null ? {} : { fulltext: parsed.fulltext }),
      judges: skUsJudges({
        rapporteurs: skUsRapporteurs(listing),
        dissenters: facetValues(facetsJson, "mkDifferentViewJudges"),
      }),
      sourceUrl: documentUrl,
      documentUrl,
      textFields: skUsCollectionTextFields(listing, collection),
      metadata: checkedDecisionMetadata(
        skUsMetadata({
          doc: listing,
          facetsJson,
          header: courtFileHeader(parts?.["file"]),
          collection,
        }),
      ),
      // The stored envelope names each object by the digest of its bytes.
      rawHash: sourceFingerprint({ sourceRaw: raw }),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_US],
      documentAst: parsed === null ? EMPTY_AST : parsed.documentAst,
      sourceRaw: raw,
      sourceRawContentType: stored.contentType ?? "application/json",
    }),
  };
};

// ── Adapter ──────────────────────────────────────────────

/**
 * Every payload this court's service serves for one decision, and whether the
 * row keeps it.
 *
 * Seven are kept: the search row that names the decision, the collection
 * listing joined only when both identities are unambiguous, the text rendering
 * and the file the court serves of the same document, the facet counts that
 * are the only statement of several index fields, the docket file the
 * document was filed under, and the vocabularies the coded fields resolve
 * against. The archive corpus is not walked; the rest of
 * the list is this service's export machinery and the portal around it.
 */
const SOURCE_SURFACES = [
  "listing",
  "details",
  "document-file",
  "document",
  "file",
  "facets",
  "codelists",
  "collection-listing",
  "archive-listing",
  "separate-opinion",
  "rss",
  "summary-export",
  "zip-export",
  "portal-search-page",
  "sitemap",
] as const;

const SK_US_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface("listing"),
    details: excludedSourceSurface(
      "verified byte for byte as the same projection the search row already states",
    ),
    "document-file": storedSourceSurface("document-file"),
    document: storedSourceSurface("document"),
    file: storedSourceSurface("file"),
    facets: storedSourceSurface("facets"),
    codelists: storedSourceSurface("codelists"),
    "collection-listing": storedSourceSurface("collection-listing"),
    "archive-listing": backlogSurface(
      ADAPTER_KEYS.SK_US,
      "separate corpus; identity reconciliation rule needed",
    ),
    "separate-opinion": excludedSourceSurface(
      "not a surface: the same query lists it as a document of its own, so it is a decision this adapter already reaches",
    ),
    rss: excludedSourceSurface(
      "the most recent items only; the date-range listing covers them and states a count",
    ),
    "summary-export": excludedSourceSurface(
      "a spreadsheet projection of listing columns, behind a challenge past its first page",
    ),
    "zip-export": excludedSourceSurface(
      "a capped batch of the same document files, behind a challenge",
    ),
    "portal-search-page": excludedSourceSurface(
      "a client-rendered shell; the search payload behind it is what this adapter reads",
    ),
    sitemap: excludedSourceSurface(
      "it lists the portal's own layouts; no per-decision address exists for it to list",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

/** The page field a crawl page's unread items fill. */
const unreadPage = (
  unreadItems: readonly UnreadListedItem[],
): Pick<SyncPage, "unreadItems"> =>
  unreadItems.length === 0 ? {} : { unreadItems };

export const skUsAdapter = defineSourceAdapter({
  documentStage: "inline",
  key: ADAPTER_KEYS.SK_US,
  sourceSurfaces: SK_US_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: SK_US_SOURCE_FIELDS,
    listSourceFields: listSkUsSourceFields,
  },
  language: "sk",
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,
  reparseStoredRaw,

  /**
   * The DMS search states `numFound` for whatever range it is asked, so one
   * single-row query over the crawl's whole date span (the first year to the
   * end of the current one) is the court's own count of the decisions this
   * adapter walks.
   */
  async getTotalCount(signal) {
    const searched = await executeSearchWithRetry({
      cursor: null,
      offset: 0,
      pageSize: 1,
      range: {
        from: `${FIRST_YEAR}-01-01`,
        to: `${Temporal.Now.plainDateISO().year}-12-31`,
      },
      signal,
    });
    if (Result.isError(searched)) {
      return { type: "probe-failed", errorTag: errorTag(searched.error) };
    }
    // A 204 carries no count; it is the endpoint declining, not an empty court.
    return searched.value.type === "unavailable"
      ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
      : sourceTotalRead(searched.value.data.numFound);
  },

  /**
   * The DMS answers a decision-date range on its own, so what a month holds is
   * answerable without the crawl cursor ever reaching it: list the month, key
   * each item the way the ingest would, and compare against what is held.
   */
  reconciliation: {
    // Publisher identity and content fields exclude listing position, query decoration, and repair aliases.
    revisionOf: (payload) =>
      isRecord(payload)
        ? {
            documentId: payload["documentId"],
            docType: payload["docType"],
            title: payload["title"],
            content: payload["content"],
            extension: payload["extension"],
            size: payload["size"],
            contentType: payload["contentType"],
            mkDocumentType: payload["mkDocumentType"],
            mkRSAPNumberOfFile: payload["mkRSAPNumberOfFile"],
            mkRVPNumberOfFile: payload["mkRVPNumberOfFile"],
            mkECLI: payload["mkECLI"],
            mkDateOfDecision: payload["mkDateOfDecision"],
            mkDateOfLegalForce: payload["mkDateOfLegalForce"],
            mkPublicationDate: payload["mkPublicationDate"],
            mkFormOfDecision: payload["mkFormOfDecision"],
            mkTypeOfDecision: payload["mkTypeOfDecision"],
            mkTypeOfProceeding: payload["mkTypeOfProceeding"],
            mkTypeOfNegotiation: payload["mkTypeOfNegotiation"],
            mkDecisionInTermsOf: payload["mkDecisionInTermsOf"],
            mkResultOfNegotiation: payload["mkResultOfNegotiation"],
            mkCause: payload["mkCause"],
            mkJudgeReporter: payload["mkJudgeReporter"],
            mkDifferentView: payload["mkDifferentView"],
            mkWordRegister: payload["mkWordRegister"],
            mkMaterialRegister: payload["mkMaterialRegister"],
            mkComplainedLegalRegulation: payload["mkComplainedLegalRegulation"],
            mkClarificationOfLegalRegulation:
              payload["mkClarificationOfLegalRegulation"],
            mkFileReference: payload["mkFileReference"],
            mkReferences: payload["mkReferences"],
            mkTypeOfProposer: payload["mkTypeOfProposer"],
            mkAffectedLegalRegulation: payload["mkAffectedLegalRegulation"],
            mkUnderage: payload["mkUnderage"],
            mkIncludeToZnaU: payload["mkIncludeToZnaU"],
            mkEntryDate: payload["mkEntryDate"],
            mkFormOfEntry: payload["mkFormOfEntry"],
            mkTypeOfEntry: payload["mkTypeOfEntry"],
            mkParentIdDecision: payload["mkParentIdDecision"],
            mkLawReportsNumber: payload["mkLawReportsNumber"],
            mkVolumeOfLawReports: payload["mkVolumeOfLawReports"],
            mkYearOfLawReports: payload["mkYearOfLawReports"],
            mkTimePeriodZNaU: payload["mkTimePeriodZNaU"],
            mkClauseTitle: payload["mkClauseTitle"],
            mkClauseText: payload["mkClauseText"],
            mkWebTitle: payload["mkWebTitle"],
          }
        : null,
    firstSlice: SK_US_FIRST_SLICE,
    sliceOf: skUsSliceOf,
    nextSlice: skUsNextSlice,
    previousSlice: skUsPreviousSlice,
    tipWindowDays: SK_US_TIP_WINDOW_SLICES,
    // The crawl keeps the listing-only row a failed PDF leaves behind and
    // `buildSkUsDecision` marks it `isListingOnly`; unset, that row would count
    // as held and its document would never be hunted again.
    //
    // Heldness is now a statement about the document, since the rows carry the
    // DMS id — see `skUsListingIdentity`. A docket's documents are hunted one
    // by one rather than through a representative, and a sibling whose PDF
    // failed no longer hides behind one that succeeded.
    heldRequiresDetail: true,
    // A row built without a part the service refused (the vocabularies, the
    // facets, the collection entry or the docket file) holds its document and
    // counts as held; it is read again on each walk of its month until a
    // build reads the part.
    recheckHeld: {
      metadataKey: SK_US_PART_READ_METADATA_KEY,
      values: [SK_US_PART_READ_STATE.WITHHELD],
    },
    listSlicePage: listSkUsSlicePage,
    buildDecision: buildSkUsFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const { year, offset, status } = parseCursor(cursor);
        const currentYear = Temporal.Now.plainDateISO().year;

        const range = { from: `${year}-01-01`, to: `${year}-12-31` };
        const slice = encodeCursor({ year, offset });
        let window: ListedWindow;
        if (status === "refused-frontier") {
          const read = await searchWindow({
            offset,
            pageSize: PAGE_SIZE,
            range,
            signal,
            slice,
          });
          window =
            read.type === "unavailable"
              ? { items: [], numFound: null }
              : listedWindow(read.data);
        } else {
          window = await listSkUsWindow({
            budget: { remaining: SPLIT_REQUEST_BUDGET },
            offset,
            pageSize: PAGE_SIZE,
            range,
            signal,
            slice,
          });
        }
        const { items, numFound } = window;
        if (numFound === null) {
          // No sub-window states a count: empty and wholly refused years are
          // indistinguishable. Reconciliation audits historical months; the
          // current frontier rechecks one window until it can be read again.
          logger.warn("case_law.ingestion.unserved_crawl_window", {
            adapterKey: ADAPTER_KEYS.SK_US,
            year,
            offset,
            reconciliation: "monthly_listing_reports_unserved_records",
          });
          return {
            decisions: [],
            itemBuildFailures: { type: "item_build_failed", count: PAGE_SIZE },
            nextCursor:
              year < currentYear
                ? encodeCursor({ year: year + 1, offset: 0 })
                : `${slice}:refused`,
          };
        }

        if (items.length === 0) {
          if (year < currentYear) {
            // Move to next year
            return {
              decisions: [],
              nextCursor: encodeCursor({ year: year + 1, offset: 0 }),
            };
          }
          // Current year exhausted; park at current offset
          return {
            decisions: [],
            nextCursor: encodeCursor({ year, offset }),
          };
        }

        const decisions: IngestionResult[] = [];
        const unreadItems: UnreadListedItem[] = [];
        let failed = 0;
        // One context for the page: the vocabularies are fetched once for
        // it, and a docket listed twice on it costs one facet query and one
        // docket-file read.
        const context = createSkUsPageContext();

        for (const item of items) {
          switch (item.type) {
            case "unserved":
              failed++;
              logger.warn("case_law.ingestion.unserved_listing_record", {
                adapterKey: ADAPTER_KEYS.SK_US,
                cursor: encodeCursor({ year, offset }),
                resultIndex: item.offset,
                outcome: "deterministic_refusal",
                reconciliation: "reports_unserved",
              });
              continue;
            case "served":
              break;
            default:
              item satisfies never;
              panic("Unhandled SK ÚS listing result");
          }
          const doc = item.document;
          try {
            const attempted = await buildPlainTextItem({
              decisionOf: (value) => {
                switch (value.type) {
                  case "built":
                  case "detail-unavailable":
                    return value.decision;
                  case "unread":
                    return value.item.listing;
                  case "unkeyable":
                    return undefined;
                  default:
                    value satisfies never;
                    return panic("Unhandled source build outcome");
                }
              },
              adapterKey: ADAPTER_KEYS.SK_US,

              rawListing: JSON.stringify(doc),
              build: async () =>
                await buildSkUsDecision(doc, {
                  context,
                  ...(signal === undefined ? {} : { signal }),
                }),
            });
            if (attempted.type === "item_build_failed") {
              failed++;
              decisions.push(attempted.decision);
              continue;
            }
            const built = attempted.value;
            switch (built.type) {
              case "unkeyable":
                break;
              // The cursor moves past this document either way, so the crawl
              // keeps the listing-only row a failed PDF still describes; only
              // the reconciliation refuses it.
              case "detail-unavailable":
              case "built":
                decisions.push(built.decision);
                break;
              // The pipeline decides what an unread document costs the page.
              case "unread":
                unreadItems.push(built.item);
                break;
              default: {
                built satisfies never;
                panic(`Unhandled SK ÚS build result: ${String(built)}`);
              }
            }
          } catch (error) {
            if (
              error instanceof DOMException ||
              error instanceof AdapterFetchError ||
              error instanceof FetchBoundaryError
            ) {
              throw error;
            }
            // The cursor moves past this document and the reconciliation walk
            // is what recovers it; reported so a build failing on every row
            // is not read as a page with nothing on it.
            failed++;
            logger.warn("case_law.ingestion.item_build_failed", {
              adapterKey: ADAPTER_KEYS.SK_US,
              ...(typeof doc.documentId === "string"
                ? { documentId: doc.documentId }
                : {}),
              "error.type": errorTag(error),
            });
            continue;
          }
        }

        const nextOffset = offset + PAGE_SIZE;
        const hasMore = items.length >= PAGE_SIZE && nextOffset < numFound;

        if (hasMore) {
          return {
            decisions,
            itemBuildFailures: { type: "item_build_failed", count: failed },
            ...unreadPage(unreadItems),
            nextCursor: encodeCursor({ year, offset: nextOffset }),
          };
        }

        // Year exhausted — advance to next year or park
        if (year < currentYear) {
          return {
            decisions,
            itemBuildFailures: { type: "item_build_failed", count: failed },
            ...unreadPage(unreadItems),
            nextCursor: encodeCursor({ year: year + 1, offset: 0 }),
          };
        }

        // Current year, short page: the cursor stops where the listing
        // stopped, not where it started. Standing still re-lists the same
        // tail and re-downloads its PDFs every cycle for nothing; a frontier
        // costs one search request on a cycle the court added nothing to.
        //
        // It reads the window the same way the walk that filled it does —
        // offsets are only stable to walk at all because this window appends
        // — and a record that lands behind the frontier is the month slices'
        // to find, not this cursor's.
        return {
          decisions,
          itemBuildFailures: { type: "item_build_failed", count: failed },
          ...unreadPage(unreadItems),
          nextCursor: encodeCursor({
            year,
            offset: offset + items.length,
          }),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_US, cursor),
    });
  },
});
