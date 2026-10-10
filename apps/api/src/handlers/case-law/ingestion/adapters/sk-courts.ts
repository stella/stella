// parser-output-unchanged: document-fetch routing metadata preserves parsed decision fields.
// parser-output-unchanged: Reconciliation revision projections classify listing inputs without changing parsed decision output.
import { panic, Result } from "better-result";

import type { SkCourtsSourceUrlStatus } from "@stll/api-contract/case-law-text-field";
import { skCourtSuccessionReferences } from "@stll/api-contract/sk-court-succession";
import { mapWithConcurrency } from "@stll/concurrency";
import {
  skDocumentErrorDiagnostics,
  skDocumentResponseDiagnostics,
} from "@stll/legal-atlas/sk-document-fetch-diagnostics";
import { readCappedBytes } from "@stll/skills/streaming";
import { parsePlainDate, Temporal } from "@stll/time";

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
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
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
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import { validatePublisherPage } from "@/api/handlers/case-law/ingestion/adapters/publisher-page";
import {
  PUBLISHER_BODY_MAX_BYTES,
  readPublisher,
  readPublisherText,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { publisherTarget } from "@/api/handlers/case-law/ingestion/adapters/publisher-target";
import { createSkCollectionConnector } from "@/api/handlers/case-law/ingestion/adapters/sk-collections";
import {
  createSkCourtRegistryReader,
  isSkCourtRegistryRecord,
  isSkCourtRegistryWithheld,
  skCourtDirectoryMetadata,
} from "@/api/handlers/case-law/ingestion/adapters/sk-court-directory";
import type {
  SkCourtRegistryReader,
  SkCourtRegistryObservation,
  SkCourtRegistryRecord,
} from "@/api/handlers/case-law/ingestion/adapters/sk-court-directory";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  parseCeDate,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
} from "@/api/lib/case-law/decision-text";
import { decisionTypeKey } from "@/api/lib/case-law/decision-type-key";
import { toPlainText } from "@/api/lib/case-law/plain-text";
import {
  READ_OUTCOME_METADATA_KEY,
  isReadRefusal,
  isStoredReadAbsence,
  readAbsent,
  readPresent,
  readUnavailable,
  type AbsenceEvidence,
  type ReadOutcome,
  type ReadRefusal,
  type ReadUnavailableCause,
  type StoredReadAbsence,
} from "@/api/lib/errors/read-outcome";
import {
  AdapterFetchError,
  FetchBoundaryError,
} from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { DOCUMENT_DELIVERY } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import type { SkDocumentFetch } from "@/api/lib/legal-search/sk-document-backfill";
import { logger } from "@/api/lib/observability/logger";
import { sanitizeUrl, toMetadataUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

import { SK_COURTS_METADATA_URL_SCHEMA } from "./sk-courts.metadata-urls";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obcan.justice.sk REST API,
 * whose pages are numbered from one (see {@link FIRST_PAGE}).
 *
 * Each list item is enriched with a detail fetch for
 * ECLI, document URL, and referenced legislation.
 *
 * Cursor formats:
 *   backfill:<item offset>      the oldest-first sweep of the collection
 *   frontier:<day>:<page>       the steady-state walk of closed days
 *
 * A bare "offset:100" predates the walks and restarts the backfill; a "live:"
 * cursor names the newest-first lap the frontier replaced and starts it.
 *
 * The same list endpoint is addressable by a decision-date range, which is
 * what makes this source reconcilable: one date can be listed on its own,
 * without the crawl cursor ever reaching it. See `reconciliation` below.
 */

const BASE_URL =
  "https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie";

/**
 * This endpoint numbers pages from one and clamps below it: `page=0` and
 * `page=1` both answer the first hundred records, `page=2` the second hundred,
 * and the response echoes `page` one lower than the request asked for.
 *
 * One statement for the whole adapter. The crawl and the slice listing walk
 * the same endpoint, so a second statement of this fact is a second chance to
 * state it differently — which is what happened: the crawl declared the
 * endpoint zero-indexed, re-read the first page on every traversal and read
 * every later page one hundred records behind its own cursor.
 */
const FIRST_PAGE = 1;

const PAGE_SIZE = 100;
const LEGACY_PAGE_SIZE = 100;
const ITEM_CONCURRENCY = 10;
const LIST_TIMEOUT_MS = 60_000;
/** The only language this source publishes; half of the fallback identity. */
export const SK_COURTS_LANGUAGE = "sk";

/**
 * PDFs are large and the court's site is slow; this is the timeout the
 * adapter used before the download was deferred to the document walk.
 */
const DOCUMENT_TIMEOUT_MS = 30_000;

/**
 * The gated download the deferred document walk runs on.
 *
 * The walk lives in `lib/legal-search/sk-document-backfill.ts`, which may not
 * import this slice, so it takes its fetch from whoever starts it and this is
 * the value every caller passes: this publisher's budget, the redirect rule
 * and the download timeout in one place.
 */
export const skCourtsDocumentFetch: SkDocumentFetch = async (
  url,
  { signal },
) => {
  const target = publisherTarget(ADAPTER_KEYS.SK_COURTS, url);
  if (Result.isError(target)) {
    logger.warn("case_law.ingestion.document_target_refused", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      reason: target.error.message,
      url: target.error.url,
    });
    return { type: "refused-target", reason: target.error.message };
  }
  const fetched = await Result.tryPromise({
    try: async () =>
      await readPublisher(target.value, {
        fetchStage: "document",
        expectedContentType: "pdf",
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        redirect: "error",
        signal,
        timeoutMs: DOCUMENT_TIMEOUT_MS,
        headers: { "User-Agent": INGESTION_USER_AGENT },
      }),
    catch: (error) => error,
  });
  if (Result.isError(fetched)) {
    logger.warn(
      "case_law.ingestion.sk_document_fetch_failed",
      skDocumentErrorDiagnostics(fetched.error),
    );
    throw fetched.error;
  }
  const read = fetched.value;
  switch (read.type) {
    case "present": {
      const diagnostics = skDocumentResponseDiagnostics(read.value);
      if (
        diagnostics.contentTypeClass !== "pdf" &&
        diagnostics.contentTypeClass !== "binary"
      ) {
        logger.warn(
          "case_law.ingestion.sk_document_fetch_response",
          diagnostics,
        );
      }
      return read;
    }
    case "absent":
    case "refused":
      return read;
    case "unavailable":
      if (read.cause.kind === "thrown") {
        logger.warn(
          "case_law.ingestion.sk_document_fetch_failed",
          skDocumentErrorDiagnostics(read.cause.error),
        );
      }
      return read;
    default:
      read satisfies never;
      return panic(`Unhandled document read: ${String(read)}`);
  }
};

const arrayOrEmpty = <T>(value: T[] | null | undefined): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return value;
};

/**
 * A courthouse's map position.
 *
 * Named but not read into: the inventory excludes both coordinates, so the
 * guard accepts the object the schema promises rather than asserting a shape
 * nothing depends on.
 */
type SkSuradnice = Readonly<Record<string, unknown>>;

/**
 * A court as this service's `BaseSud` schema declares it, excluded registry
 * columns included.
 *
 * Every property the schema states is named here even where the inventory
 * excludes it, because the two have to be comparable: a type that listed only
 * what the adapter stores is how `oblast`, `povodnySud` and
 * `povodnaSpisovaZnacka` arrived on a response this crawl paid for and were
 * dropped on the floor for years.
 */
type SkSud = {
  registreGuid?: string | null;
  nazov?: string | null;
  adresaString?: string | null;
  suradnice?: SkSuradnice | null;
};

type SkSudca = {
  registreGuid?: string | null;
  meno?: string | null;
};

export type SkApiItem = {
  guid?: string | null;
  spisovaZnacka?: string | null;
  identifikacneCislo?: string | null;
  sud?: SkSud | null;
  sudca?: SkSudca | null;
  datumVydania?: string | null;
  formaRozhodnutia?: string | null;
  povaha?: string[] | null;
  /** Search-response highlights; empty unless the request carried a query. */
  zvyraznenie?: string[] | null;
};

type SkDokument = {
  name?: string | null;
  fileExtension?: string | null;
  url?: string | null;
  /** The service's own file key, declared `int64` by its schema. */
  id?: number | null;
};

type SkOdkazovanyPredpis = {
  nazov?: string | null;
  url?: string | null;
};

type SkDetailItem = SkApiItem & {
  ecli?: string | null;
  oblast?: string[] | null;
  podOblast?: string[] | null;
  odkazovanePredpisy?: SkOdkazovanyPredpis[] | null;
  dokument?: (SkDokument & { size?: number | null }) | null;
  updateDate?: string | null;
  /**
   * Where the file came from when it was transferred between courts, and the
   * docket it carried there. Not an appeal: a first-instance decision nobody
   * appealed states both, and `spisovaZnacka` is then the same docket under a
   * prefix the receiving court added. A citation of the decision names the
   * original, so the two are stored side by side.
   */
  povodnySud?: SkSud | null;
  povodnaSpisovaZnacka?: string | null;
};

/** Validate the envelope independently so a malformed member cannot pin a page. */
type SkApiResponse = {
  rozhodnutieList: unknown[];
  numFound: number;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOptionalStringArray = (
  value: unknown,
): value is string[] | null | undefined =>
  value === undefined || value === null || isStringArray(value);

const isSkSud = (value: unknown): value is SkSud =>
  isRecord(value) &&
  isNullishString(value["registreGuid"]) &&
  isNullishString(value["nazov"]) &&
  isNullishString(value["adresaString"]) &&
  isNullishValue(value["suradnice"], isRecord);

const isSkSudca = (value: unknown): value is SkSudca =>
  isRecord(value) &&
  isNullishString(value["registreGuid"]) &&
  isNullishString(value["meno"]);

const isSkDokument = (
  value: unknown,
): value is SkDokument & { size?: number } =>
  isRecord(value) &&
  isNullishString(value["name"]) &&
  isNullishString(value["fileExtension"]) &&
  isNullishString(value["url"]) &&
  isNullishNumber(value["id"]) &&
  isNullishNumber(value["size"]);

const isSkOdkazovanyPredpis = (value: unknown): value is SkOdkazovanyPredpis =>
  isRecord(value) &&
  isNullishString(value["nazov"]) &&
  isNullishString(value["url"]);

const isSkApiItem = (value: unknown): value is SkApiItem =>
  isRecord(value) &&
  isNullishString(value["guid"]) &&
  isNullishString(value["spisovaZnacka"]) &&
  isNullishString(value["identifikacneCislo"]) &&
  isNullishValue(value["sud"], isSkSud) &&
  isNullishValue(value["sudca"], isSkSudca) &&
  isNullishString(value["datumVydania"]) &&
  isNullishString(value["formaRozhodnutia"]) &&
  isOptionalStringArray(value["povaha"]) &&
  isOptionalStringArray(value["zvyraznenie"]);

const isSkApiItemRecord = (
  value: unknown,
): value is Record<string, unknown> & SkApiItem =>
  isRecord(value) && isSkApiItem(value);

const isSkDetailItem = (value: unknown): value is SkDetailItem => {
  if (!isSkApiItemRecord(value)) {
    return false;
  }

  return (
    isNullishString(value["ecli"]) &&
    isOptionalStringArray(value["oblast"]) &&
    isOptionalStringArray(value["podOblast"]) &&
    isNullishArrayOf(value["odkazovanePredpisy"], isSkOdkazovanyPredpis) &&
    isNullishValue(value["dokument"], isSkDokument) &&
    isNullishString(value["updateDate"]) &&
    isNullishValue(value["povodnySud"], isSkSud) &&
    isNullishString(value["povodnaSpisovaZnacka"])
  );
};

const isSkApiResponse = (value: unknown): value is SkApiResponse =>
  isRecord(value) &&
  Array.isArray(value["rozhodnutieList"]) &&
  typeof value["numFound"] === "number" &&
  Number.isSafeInteger(value["numFound"]) &&
  value["numFound"] >= 0;

/** Parse Slovak date "DD.MM.YYYY" to ISO "YYYY-MM-DD". */
const parseSkDate = (raw: string | null | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const result = parseCeDate(raw);
  if (!result) {
    logger.warn("case_law.ingestion.unexpected_date_format", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      value: raw,
    });
  }
  return result;
};

/**
 * Fetch full detail for a single decision (includes ECLI,
 * document URL, and referenced legislation).
 */
const fetchDetail = async (
  guid: string,
  signal?: AbortSignal,
): Promise<ReadOutcome<SkDetailItem>> => {
  const url = `${BASE_URL}/${encodeURIComponent(guid)}`;
  const read = await readPublisherText(url, {
    fetchStage: "listing",
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    headers: { Accept: "application/json" },
  });
  if (read.type !== "present") {
    logger.warn("case_law.ingestion.detail_fetch_failed", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      guid,
      ...readDiagnostics(read),
    });
    return read;
  }
  const json = parseJsonOrNull(read.value);
  // The service answers a record it holds nothing for with an empty object:
  // its own statement that there is no record, not a failed read.
  if (isRecord(json) && Object.keys(json).length === 0) {
    return readAbsent("publisher-typed-absence");
  }
  // A served payload that is not a decision record is a read that did not
  // produce it, so the item is reported unread like a 5xx: the page holds for
  // a bounded number of cycles, never for good.
  if (!isSkDetailItem(json)) {
    return readUnavailable({
      kind: "thrown",
      error: new FetchBoundaryError({
        url,
        message: "SK courts detail response is not a decision record",
      }),
    });
  }
  return readPresent(json);
};

/** A served JSON body, or null where it does not parse. */
const parseJsonOrNull = (body: string): unknown =>
  Result.try({
    try: (): unknown => JSON.parse(body),
    catch: () => null,
  }).unwrapOr(null);

/** What a read that established no value states, for a warning. */
const readDiagnostics = (
  read: Exclude<ReadOutcome<unknown>, { type: "present" }>,
): { outcome: string; httpStatus?: number } => {
  switch (read.type) {
    case "absent":
      return { outcome: read.evidence };
    case "refused":
      return { outcome: read.type, httpStatus: read.status };
    case "unavailable":
      return { outcome: read.cause.kind, ...causeHttpStatus(read.cause) };
    default:
      read satisfies never;
      return panic(`Unhandled read: ${String(read)}`);
  }
};

/** The status a failed read was answered with, where it was answered. */
const causeHttpStatus = (
  cause: ReadUnavailableCause,
): { httpStatus?: number } => {
  switch (cause.kind) {
    case "thrown":
    case "too-large":
      return {};
    case "status":
    case "no-content":
    case "empty-body":
      return { httpStatus: cause.status };
    default:
      cause satisfies never;
      return panic(`Unhandled read cause: ${String(cause)}`);
  }
};

/**
 * The publisher's own document id for a listing item, or undefined where the
 * item states none this store can hold.
 *
 * Stated here rather than at each use so the crawl and the reconciliation
 * cannot key a decision differently. The bound is not decoration: an id past
 * the column's limit is refused by the pipeline's own normalization, so an
 * item carrying one is storable only under the docket, and keying it on the
 * id would hunt a row nothing can ever write.
 */
const skCourtsSourceDocumentId = (
  guid: string | null | undefined,
): string | undefined => {
  const value = toOptionalValue(guid);
  return value !== undefined && isPersistableSourceDocumentId(value)
    ? value
    : undefined;
};

/** The two fields this adapter refuses to store a decision without. */
type SkCourtsIdentityFields = { caseNumber: string; court: string };

/**
 * Publisher display text in the form a plain-text field stores. A value the
 * canonical form refuses is kept as stated, so assembly reports it instead of
 * this helper hiding it.
 */
const canonicalSkCourtText = (value: string): string =>
  toPlainText(value).unwrapOr(value);

// Raw payloads, URLs and source IDs stay verbatim.
const decodeSkCourtText = (value: string | null | undefined) => {
  const text = toOptionalValue(value);
  return text === undefined ? undefined : canonicalSkCourtText(text);
};

const decodeSkCourtTextList = (values: string[] | null | undefined) => {
  if (values === null || values === undefined) {
    return values;
  }
  return values.map((value) => canonicalSkCourtText(value));
};

/** The registry's display names decoded; a stated null or absence stays as stated. */
const decodeSkCourtRegistryRecord = (
  record: SkCourtRegistryRecord,
): SkCourtRegistryRecord => ({
  ...record,
  nazov: canonicalSkCourtText(record.nazov),
  ...(typeof record.typSudu === "string"
    ? { typSudu: canonicalSkCourtText(record.typSudu) }
    : {}),
  ...(typeof record.skratka_string === "string"
    ? { skratka_string: canonicalSkCourtText(record.skratka_string) }
    : {}),
});

/**
 * The docket and the court an item must state for this adapter to keep it.
 *
 * Stated once, because the crawl, the identity rule and the listing walk must
 * agree exactly on which items exist: an item one of them keeps and another
 * drops is either a decision nothing ever stores or a slice that stays short
 * forever.
 */
const skCourtsIdentityFields = (
  item: SkApiItem,
): SkCourtsIdentityFields | null => {
  const statedCaseNumber = toOptionalValue(item.spisovaZnacka);
  const statedCourt = toOptionalValue(item.sud?.nazov);
  if (!statedCaseNumber || !statedCourt) {
    return null;
  }
  // Stated markup-only labels must reach the required-label boundary with
  // their evidence intact; an empty canonical form is not source absence.
  return {
    caseNumber: canonicalSkCourtText(statedCaseNumber) || statedCaseNumber,
    court: canonicalSkCourtText(statedCourt) || statedCourt,
  };
};

/**
 * The identity the ingest would store for this listing item.
 *
 * Takes the raw item rather than a validated one, because the shape check is
 * itself part of the rule: the crawl drops a payload it cannot validate, so a
 * walk must count it as unidentifiable rather than as a decision it is missing.
 */
export const skCourtsListingIdentity = (item: unknown): ListingIdentity => {
  if (!isSkApiItem(item)) {
    return { type: "unidentifiable" };
  }
  const fields = skCourtsIdentityFields(item);
  if (fields === null) {
    return { type: "unidentifiable" };
  }
  const sourceDocumentId = skCourtsSourceDocumentId(item.guid);
  if (sourceDocumentId !== undefined) {
    return { type: "document", sourceDocumentId };
  }
  const caseNumber = toPlainText(fields.caseNumber);
  const court = toPlainText(fields.court);
  if (
    caseNumber.isErr() ||
    court.isErr() ||
    caseNumber.value.length === 0 ||
    court.value.length === 0
  ) {
    return { type: "unidentifiable" };
  }
  return {
    type: "case-number",
    caseNumber: caseNumber.value,
    language: SK_COURTS_LANGUAGE,
  };
};

/**
 * What asking the publisher's per-decision record about a listed item produced.
 *
 * `listing-only` and `unavailable` are kept apart on purpose. The crawl treats
 * both as "no detail" and stores the listing observation either way, which is
 * right for a page that must keep moving. A caller filling gaps needs the
 * difference, and here it is sharper than elsewhere: `documentUrl` is stated
 * only by this record, and the document walk selects the rows it still owes
 * text by that column. So a detail-less row is held — taking the decision out
 * of every later reconciliation — and invisible to the walk that would have
 * given it its text.
 */
type SkCourtsDetailFetch =
  | { type: "detail"; detail: SkDetailItem }
  /** The item names no record to ask about. */
  | { type: "listing-only" }
  /**
   * The publisher stated the record does not exist, or refused it: the row
   * is held listing-only with the typed outcome.
   */
  | { type: "withheld"; outcome: SkCourtsDetailOutcome }
  /**
   * A record was asked about and could not be read: the item is reported
   * unread, and the pipeline decides what that costs the page.
   */
  | { type: "unavailable"; cause: ReadUnavailableCause };

/** Why a decision is stored without its record. */
type SkCourtsDetailOutcome = StoredReadAbsence | ReadRefusal;

const isSkCourtsDetailOutcome = (
  value: unknown,
): value is SkCourtsDetailOutcome =>
  isStoredReadAbsence(value) ||
  (isReadRefusal(value) && value.scope === "document");

const fetchDetailForItem = async (
  item: SkApiItem,
  signal?: AbortSignal,
): Promise<SkCourtsDetailFetch> => {
  const guid = toOptionalValue(item.guid);
  if (guid === undefined || guid.length === 0) {
    return { type: "listing-only" };
  }
  const read = await fetchDetail(guid, signal);
  switch (read.type) {
    case "present":
      return { type: "detail", detail: read.value };
    case "absent":
      return {
        type: "withheld",
        outcome: { type: "absent", evidence: read.evidence },
      };
    case "refused":
      return { type: "withheld", outcome: read };
    case "unavailable":
      return { type: "unavailable", cause: read.cause };
    default:
      read satisfies never;
      return panic(`Unhandled detail read: ${String(read)}`);
  }
};

/** One page's record reads, each asked once. */
export type SkCourtsDetailReader = (
  item: SkApiItem,
  signal?: AbortSignal,
) => Promise<SkCourtsDetailFetch>;

/** Page-owned promise cache: bounded by the page, discarded on completion. */
export const createSkCourtsDetailReader = (
  signal?: AbortSignal,
): SkCourtsDetailReader => {
  const reads = new Map<string, Promise<SkCourtsDetailFetch>>();
  return async (item, requestSignal) => {
    const guid = toOptionalValue(item.guid) ?? "";
    const cached = reads.get(guid);
    if (cached !== undefined) {
      return await cached;
    }
    const pending = fetchDetailForItem(item, requestSignal ?? signal);
    reads.set(guid, pending);
    return await pending;
  };
};

type ReadPageDetailsOptions = {
  items: readonly unknown[];
  readDetail: SkCourtsDetailReader;
};

/**
 * Read every keyable item's record before any item is built, so a read that
 * ends the cycle (the publisher's rate-limit refusal, cancellation) rejects
 * here and fails the page with its cursor kept. Inside an item's build the
 * same rejection would be isolated as that one item's failure. A record that
 * stays unavailable is the item's, reported unread when it is built.
 */
const readPageDetails = async ({
  items,
  readDetail,
}: ReadPageDetailsOptions): Promise<void> => {
  await mapWithConcurrency({
    items: items.filter(
      (item): item is SkApiItem =>
        isSkApiItem(item) && skCourtsIdentityFields(item) !== null,
    ),
    limit: ITEM_CONCURRENCY,
    operation: async (item) => await readDetail(item),
  });
};

/** A record read that failed, as an error, with its status. */
const detailReadError = (cause: ReadUnavailableCause): AdapterFetchError =>
  new AdapterFetchError({
    message:
      cause.kind === "too-large"
        ? `SK courts decision record exceeded ${cause.maxBytes} bytes`
        : "SK courts decision record unavailable",
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    cursor: null,
    ...(cause.kind === "thrown"
      ? { cause: cause.error }
      : causeHttpStatus(cause)),
  });

type SkCourtsMetadata = Record<string, unknown> & {
  updateDate: string | undefined;
  updateDateIso: string | undefined;
  updateDateDefect:
    | { type: "invalid-publisher-date"; value: string }
    | undefined;
  statedSourceUrl: string | undefined;
  sourceUrlStatus: SkCourtsSourceUrlStatus;
};

type SkCourtsDecisionParts = {
  /** The item exactly as the publisher listed it. */
  item: SkApiItem;
  /** The per-decision record, where one was read. */
  detail: SkDetailItem | null;
  courtRegistry?: SkCourtRegistryObservation | null | undefined;
  /**
   * Why the record is missing, where the publisher stated it absent or
   * refused it. The row is then listing-only, so a stored row is never
   * overwritten with the absences of this one.
   */
  detailOutcome?: SkCourtsDetailOutcome | undefined;
};

/**
 * Both responses this source serves for a decision, each kept verbatim under
 * the name the envelope gives it.
 *
 * The detail part is absent rather than null where no record was read: a part
 * that is there states a response, and one that is not states that none was.
 */
const skCourtsSourceRaw = ({
  item,
  detail,
  courtRegistry,
  detailOutcome,
}: SkCourtsDecisionParts): {
  sourceRaw: string;
  sourceRawContentType: string;
} => {
  const registryParts =
    courtRegistry?.status === "available"
      ? { "court-registry": JSON.stringify(courtRegistry.record) }
      : {};
  const unavailableParts =
    courtRegistry === null ||
    courtRegistry === undefined ||
    courtRegistry.status === "available"
      ? {}
      : { "court-registry-unavailable": JSON.stringify(courtRegistry) };
  return {
    sourceRaw: encodeSourceRawEnvelope({
      listing: JSON.stringify(item),
      ...(detail === null ? {} : { detail: JSON.stringify(detail) }),
      ...(detailOutcome === undefined
        ? {}
        : { "detail-outcome": JSON.stringify(detailOutcome) }),
      ...registryParts,
      ...unavailableParts,
    }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

/**
 * Build one decision from the two responses already in hand, without
 * contacting the publisher, or `null` for an item nothing can key.
 *
 * The seam the crawl, the stored-payload re-parse and the conformance
 * fixtures all go through: a decision keyed or projected one way here is
 * keyed and projected that way everywhere.
 */
export const assembleSkCourtsDecision = ({
  courtRegistry,
  detail,
  detailOutcome,
  item,
}: SkCourtsDecisionParts): IngestionResult | null => {
  const fields = skCourtsIdentityFields(item);
  if (fields === null) {
    return null;
  }
  const { caseNumber, court } = fields;

  // Registry changes must reach already stored decisions; detail failures
  // still do not change the listing observation.
  const registryRecord =
    courtRegistry?.status === "available"
      ? decodeSkCourtRegistryRecord(courtRegistry.record)
      : undefined;
  const directoryMetadata =
    registryRecord === undefined
      ? undefined
      : skCourtDirectoryMetadata(registryRecord, court);
  const registryUnavailable =
    courtRegistry === null ||
    courtRegistry === undefined ||
    courtRegistry.status === "available"
      ? undefined
      : courtRegistry;
  const courtSuccession = skCourtSuccessionReferences(
    court,
    registryRecord?.nazov,
  );
  const stored = skCourtsSourceRaw({
    item,
    detail,
    courtRegistry,
    detailOutcome,
  });

  // PDF download is deferred to the document walk in the
  // ingestion worker (ingestion/sk-document-backfill.ts,
  // ordered by ingestion/sk-document-queue.ts).
  // Metadata-only ingestion (list + detail) lets us fly
  // through the 4.6M Slovak court decisions (~25 items/page
  // × ~4s/page) instead of blocking on 5-30s PDF downloads.
  // Decisions are searchable by case number, ECLI, court,
  // and date immediately; fulltext and the AST follow when
  // the walk reaches them. Until it does, the decision has
  // no readable text, so the two must ship together.

  const decisionDate = parseSkDate(item.datumVydania);
  const decisionType = decodeSkCourtText(item.formaRozhodnutia);
  const ecli = toOptionalValue(detail?.ecli);

  const updateDate = toOptionalValue(detail?.updateDate);
  const parsedUpdateDate =
    updateDate === undefined ? undefined : parseCeDate(updateDate);
  const updateDateIso =
    parsedUpdateDate === undefined
      ? undefined
      : parsePlainDate(parsedUpdateDate)?.toString();
  const statedSourceUrl = toOptionalValue(detail?.dokument?.url);
  const sourceUrl = sanitizeUrl(statedSourceUrl);
  const sourceUrlStatus = (() => {
    if (detail === null) {
      return "detail-unavailable";
    }
    if (statedSourceUrl === undefined) {
      return "not-published-by-source";
    }
    return sourceUrl === undefined ? "rejected-url" : "published";
  })();

  return plainTextIngestionResult(
    {
      caseNumber,
      ecli,
      court,
      country: ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_COURTS].country,
      language: SK_COURTS_LANGUAGE,
      decisionDate,
      decisionType,
      sourceDocumentId: skCourtsSourceDocumentId(item.guid),
      sourceUrl,
      documentUrl:
        restrictSkCourtDocumentUrl(
          toOptionalValue(detail?.dokument?.url) ?? "",
        )?.toString() ?? undefined,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      metadata: checkedDecisionMetadata(
        {
          ...directoryMetadata,
          courtSuccession,
          ...(registryUnavailable === undefined
            ? {}
            : { courtRegistry: registryUnavailable }),
          ...(detailOutcome === undefined
            ? {}
            : { [READ_OUTCOME_METADATA_KEY]: detailOutcome }),
          caseNumber,
          ecli,
          court,
          decisionDate,
          decisionType,
          decisionTypeKey: decisionTypeKey(decisionType),
          guid: toOptionalValue(item.guid),
          identifikacneCislo: toOptionalValue(item.identifikacneCislo),
          // The name this service states for a decision is the judge's or a
          // senior court officer's, and the record carries no discriminator, so
          // it stays a stated name rather than becoming a bench role. See the
          // `judge-registry` surface for what would tell the two apart.
          judge: decodeSkCourtText(item.sudca?.meno),
          judgeRegistreGuid: toOptionalValue(item.sudca?.registreGuid),
          courtRegistreGuid: toOptionalValue(item.sud?.registreGuid),
          decisionNature: decodeSkCourtTextList(item.povaha),
          area: decodeSkCourtTextList(detail?.oblast),
          subArea: decodeSkCourtTextList(detail?.podOblast),
          referencedLegislation:
            detail?.odkazovanePredpisy === null ||
            detail?.odkazovanePredpisy === undefined
              ? detail?.odkazovanePredpisy
              : detail.odkazovanePredpisy.map((reference) => ({
                  ...reference,
                  nazov: decodeSkCourtText(reference.nazov),
                  url: toMetadataUrl(reference.url, "transport-json"),
                })),
          documentName: decodeSkCourtText(detail?.dokument?.name),
          documentExtension: toOptionalValue(detail?.dokument?.fileExtension),
          documentSize: detail?.dokument?.size,
          documentFileId: detail?.dokument?.id,
          updateDate,
          updateDateIso,
          updateDateDefect:
            updateDate !== undefined && updateDateIso === undefined
              ? { type: "invalid-publisher-date", value: updateDate }
              : undefined,
          statedSourceUrl,
          sourceUrlStatus,
          originCourt: decodeSkCourtText(detail?.povodnySud?.nazov),
          originCourtRegistreGuid: toOptionalValue(
            detail?.povodnySud?.registreGuid,
          ),
          originCaseNumber: decodeSkCourtText(detail?.povodnaSpisovaZnacka),
        } satisfies SkCourtsMetadata,
        SK_COURTS_METADATA_URL_SCHEMA,
      ),
      rawHash: sourceFingerprint({ sourceRaw: stored.sourceRaw }),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
      documentAst: EMPTY_AST,
      documentDelivery: DOCUMENT_DELIVERY.DEFERRED,
      ...(detailOutcome === undefined ? {} : { isListingOnly: true }),
      ...stored,
    },
    SK_COURTS_METADATA_URL_SCHEMA,
  );
};

/**
 * What building one listed item produced.
 *
 * `detail-unavailable` still carries the decision the listing alone describes,
 * because the two callers dispose of it differently: the crawl's cursor moves
 * past this item either way, so a listing-only row is worth more to it than
 * nothing, while the reconciliation must refuse it.
 */
export type SkCourtsBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No docket or no court to key on; nothing can store this item. */
  | { type: "unkeyable" }
  /**
   * The publisher stated the decision's record absent, or refused it: the
   * listing-only row with the typed outcome; reconciliation retries.
   */
  | { type: "detail-unavailable"; decision: IngestionResult }
  /**
   * The record could not be read: `item` is the listing-only row with the
   * listing and the court registry record; the pipeline decides what it
   * costs the page.
   */
  | { type: "unread"; item: UnreadListedItem }
  /**
   * The court registry record could not be read, or an unread record's item
   * has no publisher id to key it on: nothing is built.
   */
  | { type: "read-failed"; error: AdapterFetchError };

type UnreadSkCourtsItemOptions = {
  item: SkApiItem;
  courtRegistry: SkCourtRegistryObservation | null;
  cause: ReadUnavailableCause;
};

/**
 * The listed item whose record stayed unavailable, keyed by the publisher's
 * id. The streak that bounds how long it holds the page is counted under that
 * id, so an item stating none this store can hold is not built (counted, the
 * page advancing) rather than reported unread.
 */
const unreadSkCourtsItem = ({
  item,
  courtRegistry,
  cause,
}: UnreadSkCourtsItemOptions): SkCourtsBuildResult => {
  const sourceDocumentId = skCourtsSourceDocumentId(item.guid);
  const listing = assembleSkCourtsDecision({
    item,
    detail: null,
    courtRegistry,
  });
  if (sourceDocumentId === undefined || listing === null) {
    return { type: "read-failed", error: detailReadError(cause) };
  }
  return {
    type: "unread",
    item: {
      listing: { ...listing, sourceDocumentId, isListingOnly: true },
      outcome: { type: "unavailable", cause },
    },
  };
};

/**
 * Build one decision from a listing item, through this adapter's own parse and
 * enrichment path. Shared by the crawl and the reconciliation walk so neither
 * can key, parse or enrich an item differently from the other.
 */
type SkCourtsBuildOptions = {
  signal?: AbortSignal | undefined;
  readCourt?: SkCourtRegistryReader | undefined;
  readDetail?: SkCourtsDetailReader | undefined;
};

export const buildSkCourtsDecision = async (
  item: SkApiItem,
  {
    signal,
    readCourt = createSkCourtRegistryReader(signal),
    readDetail = createSkCourtsDetailReader(signal),
  }: SkCourtsBuildOptions = {},
): Promise<SkCourtsBuildResult> => {
  // Asked before the record is fetched, so an item nothing can store never
  // costs a request; the assembler answers the same question again over what
  // it was handed.
  if (skCourtsIdentityFields(item) === null) {
    return { type: "unkeyable" };
  }
  const fetched = await readDetail(item, signal);
  const registreGuid = toOptionalValue(item.sud?.registreGuid);
  const registry =
    registreGuid === undefined
      ? Result.ok(null)
      : await readCourt(registreGuid, signal);
  if (registry.isErr()) {
    logger.warn("case_law.ingestion.court_registry_unavailable", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      ...(registreGuid === undefined ? {} : { registreGuid }),
      reason: registry.error.message,
    });
    return { type: "read-failed", error: registry.error };
  }
  if (fetched.type === "unavailable") {
    return unreadSkCourtsItem({
      item,
      courtRegistry: registry.unwrapOr(null),
      cause: fetched.cause,
    });
  }
  const detailOutcome =
    fetched.type === "withheld" ? fetched.outcome : undefined;
  const decision = assembleSkCourtsDecision({
    item,
    detail: fetched.type === "detail" ? fetched.detail : null,
    courtRegistry: registry.unwrapOr(null),
    ...(detailOutcome === undefined ? {} : { detailOutcome }),
  });
  if (decision === null) {
    return { type: "unkeyable" };
  }
  return detailOutcome === undefined
    ? { type: "built", decision }
    : { type: "detail-unavailable", decision };
};

type SkCourtsParsedItem =
  | { type: "decision"; decision: IngestionResult }
  | { type: "unread"; item: UnreadListedItem }
  | { type: "item_build_failed"; decision: IngestionResult | null };

const parseItemWithDetail = async (
  raw: unknown,
  options: SkCourtsBuildOptions = {},
): Promise<SkCourtsParsedItem> => {
  if (!isSkApiItem(raw)) {
    logger.warn("case_law.ingestion.item_build_failed", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      identity: JSON.stringify(skCourtsListingIdentity(raw)),
      reason: "Invalid listing member",
    });
    return { type: "item_build_failed", decision: null };
  }
  const attempted = await buildPlainTextItem({
    decisionOf: (value) => {
      switch (value.type) {
        case "built":
        case "detail-unavailable":
          return value.decision;
        case "unread":
          return value.item.listing;
        case "unkeyable":
        case "read-failed":
          return undefined;
        default:
          value satisfies never;
          return panic("Unhandled source build outcome");
      }
    },
    adapterKey: ADAPTER_KEYS.SK_COURTS,

    rawListing: JSON.stringify(raw),
    build: async () => await buildSkCourtsDecision(raw, options),
  });
  if (attempted.type === "item_build_failed") {
    return attempted;
  }
  const built = attempted.value;
  switch (built.type) {
    case "unkeyable":
      return { type: "item_build_failed", decision: null };
    // The page has to keep moving, and the listing observation is still worth
    // storing; the reconciliation refuses the same row, see `buildDecision`.
    case "detail-unavailable":
      return { type: "item_build_failed", decision: built.decision };
    case "built":
      return { type: "decision", decision: built.decision };
    // The pipeline decides what an unread record costs the page.
    case "unread":
      return { type: "unread", item: built.item };
    // The page reads every court registry record before building and fails
    // on one it could not read, so this is an unread record whose item has
    // no publisher id to count it under. Counted, never stored.
    case "read-failed":
      return { type: "item_build_failed", decision: null };
    default: {
      built satisfies never;
      return panic(
        `Unhandled sk-courts build result: ${JSON.stringify(built)}`,
      );
    }
  }
};

/** One list page, in the given order. */
const listRequest = (
  page: number,
  sortDirection: "ASC" | "DESC",
): { url: string; init: RequestInit } => ({
  url: `${BASE_URL}?${new URLSearchParams({
    page: String(page),
    size: String(PAGE_SIZE),
    sortProperty: "datumVydania",
    sortDirection,
  }).toString()}`,
  init: { headers: { Accept: "application/json" } },
});

// ── Reconciliation ───────────────────────────────────────

/**
 * Earliest `datumVydania` the publisher lists, and so the oldest slice the
 * historical sweep walks back to.
 *
 * Read from the source: the list sorted by `datumVydania` ascending opens on
 * this date, and the same date filter closed one day earlier states a count of
 * zero. What sits either side of it is nearly empty — two decisions before
 * 1990, six across the 1990s, 81 across 2000-2004, against 4.6M since — but
 * the sweep runs newest-first, so that sparse tail is surveyed last rather
 * than standing between the loop and the dense years.
 */
export const SK_COURTS_FIRST_SLICE =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_COURTS].dateRange.fromInclusive;

/**
 * Days near the tip that get re-walked on a fast cadence.
 *
 * A slice here is the decision date, and this publisher posts a decision long
 * after it is handed down. That is the whole reason this is not the fortnight
 * a same-day publisher needs: a slice recorded as fully collected is settled,
 * and a settled slice is never re-walked and never swept again, so a date
 * walked while it is still filling is a date the loop has finished with at a
 * fraction of its content. Measured against the volume the same weekday
 * settles at, a date holds under half its eventual decisions at seven weeks.
 *
 * The window is sized past where that filling stops, sampling ten Wednesdays
 * per age band so court sitting patterns cannot explain the difference: the
 * median at 130-200 days old is 615 decisions, at 330-400 days 621, and at
 * 700-770 days 637. A date has therefore effectively stopped growing well
 * inside a window this wide, and the ~3% still arriving over the two years
 * after that is the residual below.
 *
 * Known limit, stated because it is invisible otherwise: a decision published
 * past the window is not recovered. Its slice is settled, so no reconciliation
 * unit selects it again, and the crawl does not reach it either — the frontier
 * has passed that date and does not go back. Closing it needs the loop to
 * re-survey settled slices on a slow
 * cadence, which is the engine's decision to make, not an adapter's: the
 * capability's only lever over what gets re-walked is this number, and buying
 * the last few percent with it would mean re-walking hundreds of dates daily
 * for good.
 */
const SK_COURTS_TIP_WINDOW_DAYS = 140;

/**
 * Page size for a listing walk. The crawl takes 100 at a time because every
 * item on its page costs a detail fetch; a listing walk fetches nothing per
 * item, so it asks for the largest page that stays quick — 1000 items answered
 * in ~2.3s, where 2000 took ~5.6s for no fewer requests per decision. The
 * busiest decision date observed holds 2,559, so a slice is at most three
 * pages, and a date still filling in at the tip is always one.
 */
const LISTING_PAGE_SIZE = 1000;

/**
 * A reconciliation slice numbers its pages from zero, so a page is requested
 * one higher than it is named. Same endpoint fact as {@link FIRST_PAGE},
 * stated through it rather than beside it.
 */
const LISTING_FIRST_PAGE = FIRST_PAGE;

/**
 * Ordering for a slice listing. `guid` is unique and never reassigned, so it
 * is a total order over the slice that existing items keep whatever the
 * publisher adds to it: a decision indexed between two page requests can only
 * push later items further back, which a walk sees as a repeat — the loop keys
 * items and drops the duplicate — rather than as an item that slipped past.
 * The endpoint's default ordering offers no such guarantee.
 */
const SLICE_SORT_PROPERTY = "guid";
const SLICE_SORT_DIRECTION = "ASC";

/**
 * A reconciliation slice for this source is one UTC calendar day of decision
 * dates, `YYYY-MM-DD`, which sorts lexicographically in chronological order —
 * the ordering the ledger relies on.
 *
 * The day, and this date, because the publisher answers a `vydaniaOd`/
 * `vydaniaDo` range precisely and exhaustively: a single-day range comes back
 * holding only that date, adjacent days sum to the range that spans them, and
 * the disjoint date buckets covering the corpus add up to exactly the total
 * the endpoint reports for no filter at all. So every decision falls in one
 * slice and none falls outside all of them.
 *
 * The publisher also filters on the date it indexed a decision, which would
 * give slices that never change once past. That axis is unusable here for the
 * opposite reason: it puts 4.19M of the 4.68M decisions on the index dates of
 * a single year, and a slice of that size cannot be walked to the end, so the
 * ledger could never record it at all.
 */
const skCourtsDaySlices = createCalendarDaySliceWalk({
  firstSlice: SK_COURTS_FIRST_SLICE,
  source: ADAPTER_KEYS.SK_COURTS,
});

/**
 * One page of the publisher's own listing for a decision date.
 *
 * A failed request is thrown, never flattened into an empty page. The crawl
 * can afford to read a dead page as "nothing here" because a cursor that moves
 * on can be walked again; a ledger row cannot, since an outage recorded as an
 * empty date settles that date and it is never revisited. So only a body that
 * states a count answers what a date holds: `numFound: 0` is an empty slice,
 * and everything else — a 5xx, a timeout, a body without a count — is an error
 * the engine retries on a later pass.
 */
type ListDayPageOptions = {
  day: string;
  page: number;
  pageSize: number;
  signal?: AbortSignal | undefined;
};

/** What one page of a day's listing states: its rows, and the day's size. */
type ListedDayPage = {
  listed: unknown[];
  total: number;
};

/**
 * One page of the publisher's own listing for a decision date.
 *
 * Both the steady-state frontier and the reconciliation ledger read a date
 * through this, at their own page sizes: the frontier enriches every row it
 * takes, so it asks for a page it can finish, while the ledger fetches
 * nothing per row and asks for the largest page the endpoint answers quickly.
 *
 * A failed request is thrown, never flattened into an empty page. The crawl
 * can afford to read a dead page as "nothing here" because a cursor that moves
 * on can be walked again; a ledger row cannot, since an outage recorded as an
 * empty date settles that date and it is never revisited. So only a body that
 * states a count answers what a date holds: `numFound: 0` is an empty slice,
 * and everything else — a 5xx, a timeout, a body without a count — is an error
 * the engine retries on a later pass.
 */
type ListingReadErrorOptions = {
  read: Exclude<ReadOutcome<unknown>, { type: "present" }>;
  cursor: string;
};

/**
 * The error a listing request that served no listing stands for: with its
 * status, so the engine reads a refusal or an outage as it did, and the
 * original error where the request threw.
 */
const listingReadError = ({ read, cursor }: ListingReadErrorOptions): Error => {
  switch (read.type) {
    case "absent":
      return listingStatusError({
        status: absenceStatus(read.evidence),
        cursor,
      });
    case "refused":
      return listingStatusError({ status: read.status, cursor });
    case "unavailable":
      return listingFailureError({ cause: read.cause, cursor });
    default:
      read satisfies never;
      return panic(`Unhandled listing read: ${String(read)}`);
  }
};

const listingStatusError = ({
  status,
  cursor,
}: {
  status: number;
  cursor: string;
}): AdapterFetchError =>
  new AdapterFetchError({
    message: `SK courts listing API error: ${status}`,
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    cursor,
    httpStatus: status,
  });

const listingFailureError = ({
  cause,
  cursor,
}: {
  cause: ReadUnavailableCause;
  cursor: string;
}): Error => {
  switch (cause.kind) {
    case "thrown":
      return thrownReadError(cause.error);
    case "too-large":
      return new AdapterFetchError({
        message: `SK courts listing exceeded ${cause.maxBytes} bytes`,
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        cursor,
      });
    case "status":
    case "no-content":
    case "empty-body":
      return listingStatusError({ status: cause.status, cursor });
    default:
      cause satisfies never;
      return panic(`Unhandled read cause: ${String(cause)}`);
  }
};

/** The error a publisher request threw, as it was thrown. */
const thrownReadError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new AdapterFetchError({
        message: "SK courts publisher request failed",
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        cursor: null,
        cause: error,
      });

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

const listSkCourtsDayPage = async ({
  day,
  page,
  pageSize,
  signal,
}: ListDayPageOptions): Promise<ListedDayPage> => {
  // Refused here rather than at the publisher: this endpoint ignores a date it
  // cannot parse and answers the whole 4.6M-decision collection instead, which
  // a walk would read as one date holding all of it.
  skCourtsDaySlices.dayStart(day);
  const url = `${BASE_URL}?${new URLSearchParams({
    page: String(page + LISTING_FIRST_PAGE),
    size: String(pageSize),
    sortProperty: SLICE_SORT_PROPERTY,
    sortDirection: SLICE_SORT_DIRECTION,
    vydaniaOd: day,
    vydaniaDo: day,
  }).toString()}`;

  const read = await readPublisherText(url, {
    fetchStage: "listing",
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    signal,
    timeoutMs: LIST_TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      "User-Agent": INGESTION_USER_AGENT,
    },
  });
  if (read.type !== "present") {
    throw listingReadError({ read, cursor: day });
  }

  const json = parseJsonOrNull(read.value);
  if (!isSkApiResponse(json)) {
    throw new AdapterFetchError({
      message:
        "SK courts listing API stated no count and item list for the slice",
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      cursor: day,
    });
  }

  const { numFound: total, rozhodnutieList: listed } = json;
  // The count and the list have to agree about this page existing. They are
  // read from one response, so an offset the count says is populated answering
  // with nothing is the publisher contradicting itself, not a date running out
  // — and a page dropped here is not merely lost, it is written to the ledger
  // as part of what the date holds.
  if (total > page * pageSize && listed.length === 0) {
    throw new AdapterFetchError({
      message: `SK courts listing API stated ${total} for ${day} but listed nothing at page ${page}`,
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      cursor: day,
    });
  }

  return { listed, total };
};

const listSkCourtsSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const { listed, total } = await listSkCourtsDayPage({
    day: slice,
    page,
    pageSize: LISTING_PAGE_SIZE,
    signal,
  });
  return {
    items: listed.map((item) => ({
      identity: skCourtsListingIdentity(item),
      payload: item,
    })),
    totalPages: Math.ceil(total / LISTING_PAGE_SIZE),
  };
};

/**
 * Rebuild a decision from a payload the loop stored verbatim. The payload is
 * revalidated rather than trusted: it may have been parked for days, and a
 * shape the adapter no longer recognises has to be reported as unbuildable
 * instead of parsed on faith.
 */
const buildSkCourtsFromPayload = async (
  payload: unknown,
  options: SkCourtsBuildOptions = {},
): Promise<ReconciliationBuildOutcome> => {
  if (!isSkApiItem(payload)) {
    return { type: "unkeyable" };
  }
  const built = await buildSkCourtsDecision(payload, options);
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    // Written as a decision it would make the identity held with the document
    // still unread, and unread is how the document walk finds its work.
    case "detail-unavailable":
    case "unread":
    case "read-failed":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(
        `Unhandled sk-courts build result: ${JSON.stringify(built)}`,
      );
    }
  }
};

// ── Steady-state frontier ────────────────────────────────

/**
 * What the newest-first lap used to be called, and what replaced it.
 *
 * The lap re-listed the newest five thousand decisions every cycle — fifty
 * pages of a hundred, all of them already held — so an hour in which the
 * publisher indexed nothing cost the same fifty requests as an hour in which
 * it indexed a thousand. The frontier costs requests only for days
 * that have closed since the last one it listed, and nothing at all for a day
 * that has not closed yet.
 */
const LIVE_PHASE = "live";
const FRONTIER_PHASE = "frontier";

const FRONTIER_CURSOR =
  /^frontier:(?<day>\d{4}-\d{2}-\d{2}):(?<page>\d{1,6})$/u;

/**
 * Where the frontier picks up when the backfill hands over, or when a `live:`
 * cursor from the lap this replaced arrives: two days back, so the first
 * cycle lists yesterday rather than standing still for a day.
 *
 * The lap had been re-reading about two months of decision dates every hour
 * up to that point, so nothing between the handover and here is unseen, and
 * what the publisher indexes late against an already-listed date is the
 * ledger's to find within its {@link SK_COURTS_TIP_WINDOW_DAYS} window —
 * which reaches further back than the lap ever did.
 */
const FRONTIER_HANDOVER_LOOKBACK_DAYS = 2;

/** The last day the frontier listed to the end, and where it is in the next. */
type SkCourtsFrontier = { verifiedThrough: string; page: number };

const encodeFrontierCursor = ({
  verifiedThrough,
  page,
}: SkCourtsFrontier): string => `${FRONTIER_PHASE}:${verifiedThrough}:${page}`;

const handoverFrontier = (): SkCourtsFrontier => ({
  verifiedThrough: Temporal.Now.plainDateISO("UTC")
    .subtract({ days: FRONTIER_HANDOVER_LOOKBACK_DAYS })
    .toString(),
  page: 0,
});

/**
 * The frontier a cursor names, or `null` when the cursor belongs to the
 * backfill walk instead.
 *
 * A `live:` cursor and the bare `frontier:0` the backfill hands over with
 * both start the frontier: neither states a day, and both mean the
 * collection has been seen.
 */
const decodeFrontierCursor = (
  cursor: string | null,
): SkCourtsFrontier | null => {
  if (cursor === null) {
    return null;
  }
  const groups = FRONTIER_CURSOR.exec(cursor)?.groups;
  const day = groups?.["day"];
  const page = groups?.["page"];
  if (day !== undefined && page !== undefined) {
    return { verifiedThrough: day, page: Number.parseInt(page, 10) };
  }
  return cursor.startsWith(`${FRONTIER_PHASE}:`) ||
    cursor.startsWith(`${LIVE_PHASE}:`)
    ? handoverFrontier()
    : null;
};

/**
 * The next publisher day that has closed, or `null` while none has.
 *
 * Closed, not merely elapsed: a day still in progress would be listed at a
 * fraction of what it ends up holding and then never listed again, so the
 * frontier waits for UTC midnight to pass before it takes a day.
 */
const nextClosedDay = (verifiedThrough: string): string | null => {
  const day = parsePlainDate(verifiedThrough);
  if (day === null) {
    return panic(
      `sk-courts frontier is not a calendar day: ${verifiedThrough}`,
    );
  }
  const next = day.add({ days: 1 }).toString();
  return next < Temporal.Now.plainDateISO("UTC").toString() ? next : null;
};

/**
 * One page of the frontier.
 *
 * A cycle on which no day has closed returns the cursor it was given and
 * spends nothing, which is what lets the runner tell "caught up" from
 * "working". Completeness is not this phase's claim: what the publisher
 * indexes against a date after the frontier has passed it is found by the
 * reconciliation ledger, which walks the same date listing this does.
 */
const collectFrontierPage = async (
  frontier: SkCourtsFrontier,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const day = nextClosedDay(frontier.verifiedThrough);
  if (day === null) {
    return Result.ok({
      decisions: [],
      nextCursor: encodeFrontierCursor({
        verifiedThrough: frontier.verifiedThrough,
        page: 0,
      }),
    });
  }

  const { listed, total } = await listSkCourtsDayPage({
    day,
    page: frontier.page,
    pageSize: PAGE_SIZE,
    signal,
  });
  const readCourt = createSkCourtRegistryReader(signal);
  const readDetail = createSkCourtsDetailReader(signal);
  const records = await mapWithConcurrency({
    items: [
      ...new Set(
        listed.flatMap((item) => {
          if (!isSkApiItem(item) || skCourtsIdentityFields(item) === null) {
            return [];
          }
          const id = item.sud?.registreGuid;
          return id === null || id === undefined ? [] : [id];
        }),
      ),
    ],
    limit: ITEM_CONCURRENCY,
    operation: async (id) => await readCourt(id),
  });
  for (const record of records) {
    if (record.isErr()) {
      return record;
    }
  }
  await readPageDetails({ items: listed, readDetail });
  const built = await mapWithConcurrency({
    items: listed,
    limit: ITEM_CONCURRENCY,
    operation: async (item) =>
      await parseItemWithDetail(item, { signal, readCourt, readDetail }),
  });
  const decisions: IngestionResult[] = [];
  const unreadItems: UnreadListedItem[] = [];
  let failed = 0;
  for (const item of built) {
    switch (item.type) {
      case "decision":
        decisions.push(item.decision);
        break;
      case "unread":
        unreadItems.push(item.item);
        break;
      case "item_build_failed":
        failed++;
        if (item.decision !== null) {
          decisions.push(item.decision);
        }
        break;
      default:
        item satisfies never;
        return panic(`Unhandled sk-courts page item: ${String(item)}`);
    }
  }

  const nextPage = frontier.page + 1;
  return Result.ok({
    decisions,
    itemBuildFailures: { type: "item_build_failed", count: failed },
    ...(unreadItems.length === 0 ? {} : { unreadItems }),
    nextCursor:
      nextPage * PAGE_SIZE < total
        ? encodeFrontierCursor({
            verifiedThrough: frontier.verifiedThrough,
            page: nextPage,
          })
        : encodeFrontierCursor({ verifiedThrough: day, page: 0 }),
  });
};

// ── Source fields ────────────────────────────────────────

/**
 * The property paths one stored response states, spelled the way this
 * service's own schema spells them.
 *
 * A nested object contributes its leaves rather than itself (`sud.nazov`, not
 * `sud`), and a list of objects contributes one path per leaf however many
 * entries it holds (`odkazovanePredpisy[].nazov`). That is exactly the shape
 * `/v3/api-docs` declares, so the inventory below and the publisher's schema
 * are comparable name for name — which is what `sk-courts.test.ts` compares.
 */
const statedPropertyPaths = (value: unknown, prefix: string): string[] => {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const path = `${prefix}${key}`;
    if (isRecord(child)) {
      return statedPropertyPaths(child, `${path}.`);
    }
    if (Array.isArray(child) && child.some(isRecord)) {
      return child.flatMap((entry) => statedPropertyPaths(entry, `${path}[].`));
    }
    return [path];
  });
};

/** The parts of the envelope that carry fields about the decision itself. */
const SK_COURTS_FIELD_PARTS = ["listing", "detail"] as const;

const listSkCourtsSourceFields = (parts: SourceRawParts): readonly string[] => {
  const stated = new Set<string>();
  for (const part of SK_COURTS_FIELD_PARTS) {
    const payload = parts[part];
    if (payload === undefined) {
      continue;
    }
    const parsed = Result.try((): unknown => JSON.parse(payload)).unwrapOr(
      null,
    );
    for (const path of statedPropertyPaths(parsed, "")) {
      stated.add(path);
    }
  }
  return [...stated];
};

/**
 * What this service states about a decision, and what becomes of it.
 *
 * Keyed on the property paths of the `Rozhodnutie` schema the service itself
 * publishes, so the map is total over the payload by construction: the detail
 * record is a superset of the listing row, and a path the publisher adds to
 * either reaches `listSourceFields` as an undeclared field rather than as
 * silence.
 *
 * The three court-registry paths are excluded twice over, once for the
 * deciding court and once for the transferring one: they describe a
 * courthouse rather than a decision, and repeat unchanged on every decision
 * that court has ever issued.
 */
const SK_COURTS_SOURCE_FIELDS = {
  guid: { disposition: "stored", target: { type: "identity" } },
  formaRozhodnutia: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  povaha: {
    disposition: "stored",
    target: { type: "metadata", key: "decisionNature" },
  },
  "sud.registreGuid": {
    disposition: "stored",
    target: { type: "metadata", key: "courtRegistreGuid" },
  },
  "sud.nazov": {
    disposition: "stored",
    target: { type: "result", key: "court" },
  },
  "sud.adresaString": excludedSourceField(
    "the courthouse's postal address, identical on every decision that court issues; it describes the court register, not the decision",
  ),
  "sud.suradnice.zemepisnaDlzka": excludedSourceField(
    "the courthouse's map position, as for its address",
  ),
  "sud.suradnice.zemepisnaSirka": excludedSourceField(
    "the courthouse's map position, as for its address",
  ),
  "sudca.registreGuid": {
    disposition: "stored",
    target: { type: "metadata", key: "judgeRegistreGuid" },
  },
  "sudca.meno": {
    disposition: "stored",
    target: { type: "metadata", key: "judge" },
  },
  identifikacneCislo: {
    disposition: "stored",
    target: { type: "metadata", key: "identifikacneCislo" },
  },
  spisovaZnacka: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  datumVydania: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  zvyraznenie: excludedSourceField(
    "fragments of the decision highlighted against a search term the request carried; the crawl sends none, so it is a property of the query rather than of the decision",
  ),
  ecli: { disposition: "stored", target: { type: "result", key: "ecli" } },
  oblast: { disposition: "stored", target: { type: "metadata", key: "area" } },
  podOblast: {
    disposition: "stored",
    target: { type: "metadata", key: "subArea" },
  },
  "odkazovanePredpisy[].nazov": {
    disposition: "stored",
    target: { type: "metadata", key: "referencedLegislation" },
  },
  "odkazovanePredpisy[].url": {
    disposition: "stored",
    target: { type: "metadata", key: "referencedLegislation" },
  },
  "dokument.name": {
    disposition: "stored",
    target: { type: "metadata", key: "documentName" },
  },
  "dokument.fileExtension": {
    disposition: "stored",
    target: { type: "metadata", key: "documentExtension" },
  },
  "dokument.size": {
    disposition: "stored",
    target: { type: "metadata", key: "documentSize" },
  },
  "dokument.url": {
    disposition: "stored",
    target: { type: "result", key: "documentUrl" },
  },
  "dokument.id": {
    disposition: "stored",
    target: { type: "metadata", key: "documentFileId" },
  },
  updateDate: {
    disposition: "stored",
    target: { type: "metadata", key: "updateDate" },
  },
  "povodnySud.registreGuid": {
    disposition: "stored",
    target: { type: "metadata", key: "originCourtRegistreGuid" },
  },
  "povodnySud.nazov": {
    disposition: "stored",
    target: { type: "metadata", key: "originCourt" },
  },
  "povodnySud.adresaString": excludedSourceField(
    "the transferring courthouse's postal address, as for the deciding court's",
  ),
  "povodnySud.suradnice.zemepisnaDlzka": excludedSourceField(
    "the transferring courthouse's map position, as for the deciding court's",
  ),
  "povodnySud.suradnice.zemepisnaSirka": excludedSourceField(
    "the transferring courthouse's map position, as for the deciding court's",
  ),
  povodnaSpisovaZnacka: {
    disposition: "stored",
    target: { type: "metadata", key: "originCaseNumber" },
  },
} as const satisfies Record<string, SourceFieldDisposition>;

/** The paths the inventory decides about, for the schema diff in the tests. */
export const SK_COURTS_SOURCE_FIELD_PATHS = Object.keys(
  SK_COURTS_SOURCE_FIELDS,
);

// ── Stored payloads ──────────────────────────────────────

const SK_COURTS_REPARSABLE_CONTENT_TYPES = new Set([
  "application/json",
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
]);

/**
 * Read both the current envelope and the wrapper object stored before it.
 *
 * Rows written before the cutover carry `{ listItem, detail }` under
 * `application/json`, and there are several million of them, so the wrapper
 * is a shape this reader accepts forever rather than one it writes.
 */
const skCourtsStoredRawParts = (
  raw: string,
  contentType: string | null,
): SourceRawParts | null => {
  const envelope = decodeSourceRawEnvelope(raw);
  if (envelope !== null) {
    return envelope;
  }
  if (contentType !== null && contentType !== "application/json") {
    return null;
  }
  const parsed = Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
  if (!isRecord(parsed)) {
    return null;
  }
  const listItem = parsed["listItem"];
  const detail = parsed["detail"];
  if (!isRecord(listItem)) {
    return null;
  }
  return {
    listing: JSON.stringify(listItem),
    ...(isRecord(detail) ? { detail: JSON.stringify(detail) } : {}),
  };
};

/** One stored part, back as the shape the adapter validates it against. */
const storedPart = <T>(
  payload: string | undefined,
  isShape: (value: unknown) => value is T,
): T | null => {
  if (payload === undefined) {
    return null;
  }
  const parsed = Result.try((): unknown => JSON.parse(payload)).unwrapOr(null);
  return isShape(parsed) ? parsed : null;
};

type SkCourtsStoredDocketMatchOptions = { stored: string; replayed: string };

type SkCourtsStoredDocketMatch = "same" | "legacy-encoded" | "different";

/**
 * How a row's stored docket relates to the one its payload now parses to.
 *
 * Rows written before display text was decoded hold the publisher's encoded
 * spelling (`7C&#x2F;221/1991`). That is the same docket exactly when its
 * canonical plain-text form, the one ingestion now stores, is the replayed
 * value. Anything else, a spelling the canonical form refuses included, is a
 * different docket.
 */
const skCourtsStoredDocketMatch = ({
  stored,
  replayed,
}: SkCourtsStoredDocketMatchOptions): SkCourtsStoredDocketMatch => {
  if (stored === replayed) {
    return "same";
  }
  const canonical = toPlainText(stored);
  return canonical.isOk() && canonical.value === replayed
    ? "legacy-encoded"
    : "different";
};

/**
 * Rebuild a decision from the responses already stored for it.
 *
 * The fields this adapter reads have grown past what it read when most rows
 * were written — the legal area, the transferring court and the docket the
 * file carried there all arrive on a record the crawl already paid for. They
 * are recoverable without asking the publisher again precisely because that
 * record was kept, which is the whole argument for storing it.
 */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !SK_COURTS_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }

  const parts = skCourtsStoredRawParts(
    new TextDecoder().decode(stored.raw),
    stored.contentType,
  );
  const item = storedPart(parts?.["listing"], isSkApiItem);
  if (item === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `no listing row in the stored payload for ${stored.caseNumber}`,
    };
  }

  const registryRecord = storedPart(
    parts?.["court-registry"],
    isSkCourtRegistryRecord,
  );
  const registryUnavailable = storedPart(
    parts?.["court-registry-unavailable"],
    isSkCourtRegistryWithheld,
  );
  const detailOutcome = storedPart(
    parts?.["detail-outcome"],
    isSkCourtsDetailOutcome,
  );
  const courtRegistry =
    registryRecord === null
      ? registryUnavailable
      : { status: "available" as const, record: registryRecord };
  if (
    (parts?.["court-registry"] !== undefined &&
      (registryRecord === null ||
        registryRecord.registreGuid !== item.sud?.registreGuid)) ||
    (parts?.["court-registry-unavailable"] !== undefined &&
      registryUnavailable === null) ||
    (parts?.["detail-outcome"] !== undefined && detailOutcome === null) ||
    (registryRecord !== null && registryUnavailable !== null)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "Invalid or mismatched stored court registry record",
    };
  }
  const decision = assembleSkCourtsDecision({
    item,
    detail: storedPart(parts?.["detail"], isSkDetailItem),
    courtRegistry,
    ...(detailOutcome === null ? {} : { detailOutcome }),
  });
  if (decision === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `the stored listing row for ${stored.caseNumber} states no docket and court to key on`,
    };
  }
  const docket = skCourtsStoredDocketMatch({
    stored: stored.caseNumber,
    replayed: decision.caseNumber,
  });
  if (docket === "different") {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored payload states ${decision.caseNumber}`,
    };
  }
  if (docket === "same") {
    return { type: "parsed", result: decision };
  }
  // A row keyed by its docket cannot move to the decoded spelling: the write
  // would find no row under it and insert the decision a second time.
  if (decision.sourceDocumentId === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored docket decodes to ${decision.caseNumber}, but the row has no publisher id to migrate it under`,
    };
  }
  return {
    type: "parsed",
    result: decision,
    legacyCaseNumber: stored.caseNumber,
  };
};

// ── Source surfaces ──────────────────────────────────────

/**
 * Every payload this service serves for one decision, and whether the row
 * keeps it.
 *
 * The listing row and the detail record are both kept, each verbatim. The
 * document file is fetched by a separate walk that keeps no part of it, so it
 * is the one surface of this source that is read and thrown away. The rest are
 * service-wide: a schema, registries, code lists, a hearing calendar and a
 * mirror this project is not the publisher of.
 */
const SOURCE_SURFACES = [
  "listing",
  "detail",
  "document",
  "openapi",
  "judge-registry",
  "court-registry",
  "portal-viewer",
  "listing-facets",
  "code-lists",
  "hearing-calendar",
  "autocomplete",
  "bulk-dump",
  "third-party-mirror",
] as const;

const SK_COURTS_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface("listing"),
    detail: storedSourceSurface("detail"),
    document: backlogSurface(
      ADAPTER_KEYS.SK_COURTS,
      "binary part; envelope object references not yet available",
    ),
    openapi: excludedSourceSurface(
      "the service's own schema: the field list an inventory is written from, not a payload about any one decision",
    ),
    "judge-registry": excludedSourceSurface(
      "a record per person rather than per decision, and the roster import is the pass that reads it",
    ),
    "court-registry": storedSourceSurface("court-registry"),
    "portal-viewer": excludedSourceSurface(
      "a page shell the publisher's robots policy disallows, over the same record the detail part carries",
    ),
    "listing-facets": excludedSourceSurface(
      "counts over a result set: a coverage oracle, not a field of any decision",
    ),
    "code-lists": excludedSourceSurface(
      "reference vocabulary, not a payload about any one decision",
    ),
    "hearing-calendar": excludedSourceSurface(
      "it names the parties to proceedings that have not been decided; data minimization",
    ),
    autocomplete: excludedSourceSurface("a strict subset of the listing row"),
    "bulk-dump": backlogSurface(
      ADAPTER_KEYS.SK_COURTS,
      "the open-data catalogue is a client-rendered application and answered every documented address with its own shell, so whether a dump exists is unsettled",
    ),
    "third-party-mirror": excludedSourceSurface(
      "a republication by someone other than the publisher",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

export const skCourtsAdapter = defineSourceAdapter({
  documentStage: "deferred",
  key: ADAPTER_KEYS.SK_COURTS,
  collectionEnrichment: createSkCollectionConnector({ status: "disabled" }),
  sourceSurfaces: SK_COURTS_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: SK_COURTS_SOURCE_FIELDS,
    listSourceFields: listSkCourtsSourceFields,
  },
  reparseStoredRaw,
  language: "sk",
  minRequestIntervalMs: 300,
  // PDF download deferred; pages now only do list + detail JSON.
  // With ITEM_CONCURRENCY = 10 detail fetches in parallel and
  // ~2s per detail, 100 items take ~20s wall time. Allow headroom
  // for network jitter and the list fetch itself.
  pageTimeoutMs: 120_000,
  // Page is ~25s wall time at PAGE_SIZE=100, ITEM_CONCURRENCY=10.
  // 30 min cycle fits ~70 pages = ~7000 decisions per cursor persist.
  maxCycleMs: 30 * 60 * 1000,

  /**
   * The list endpoint reports `numFound` for the whole collection, so one
   * minimal request measures the source. Without it this corpus — the
   * largest we hold — has no completeness signal at all.
   */
  async getTotalCount(signal) {
    const read = await readPublisherText(
      `${BASE_URL}?${new URLSearchParams({ page: "0", size: "1" }).toString()}`,
      {
        fetchStage: "listing",
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        signal,
        headers: { Accept: "application/json" },
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      },
    );
    if (read.type === "unavailable" && read.cause.kind === "thrown") {
      throw thrownReadError(read.cause.error);
    }
    if (
      read.type === "unavailable" &&
      (read.cause.kind === "too-large" || read.cause.kind === "empty-body")
    ) {
      return sourceTotalProbeFailed(
        SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
      );
    }
    if (read.type !== "present") {
      return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
    }
    const json = parseJsonOrNull(read.value);
    if (!isRecord(json)) {
      return sourceTotalProbeFailed(
        SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
      );
    }
    const total = json["numFound"];
    return typeof total === "number"
      ? sourceTotalRead(total)
      : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD);
  },

  /**
   * The publisher lists each decision date independently of the crawl's offset
   * cursor, so what a date holds is answerable without re-crawling to it:
   * enumerate the date, key each item the way the ingest would, and compare
   * against what is held.
   */
  reconciliation: {
    // Publisher identity and content fields exclude listing position, query decoration, and repair aliases.
    revisionOf: (payload) =>
      isRecord(payload)
        ? {
            guid: payload["guid"],
            spisovaZnacka: payload["spisovaZnacka"],
            identifikacneCislo: payload["identifikacneCislo"],
            sud: payload["sud"],
            sudca: payload["sudca"],
            datumVydania: payload["datumVydania"],
            formaRozhodnutia: payload["formaRozhodnutia"],
            povaha: payload["povaha"],
          }
        : null,
    // A row the crawl stored without its record is not held: the walk asks
    // for it again until the record is read.
    heldRequiresDetail: true,
    firstSlice: SK_COURTS_FIRST_SLICE,
    ...skCourtsDaySlices.walk,
    tipWindowDays: SK_COURTS_TIP_WINDOW_DAYS,
    listSlicePage: listSkCourtsSlicePage,
    buildDecision: async (payload, signal) =>
      await buildSkCourtsFromPayload(payload, { signal }),
    createSliceBuildDecision: () => {
      const readCourt = createSkCourtRegistryReader();
      return async (payload, signal) =>
        await buildSkCourtsFromPayload(payload, { signal, readCourt });
    },
  },

  fetchPage: async (cursor, config, signal) => {
    const frontier = decodeFrontierCursor(cursor);
    if (frontier === null) {
      const page = await createBackfillPage(
        createSkCourtRegistryReader(signal),
        createSkCourtsDetailReader(signal),
      )(cursor, config, signal);
      // The walk names its successor and nothing else, so the handover
      // cursor it writes states no day. Give it one here rather than
      // persisting a cursor in neither phase's grammar.
      if (page.isErr()) {
        return page;
      }
      const next = page.value.nextCursor;
      if (
        next === null ||
        FRONTIER_CURSOR.test(next) ||
        decodeFrontierCursor(next) === null
      ) {
        return page;
      }
      return Result.ok({
        ...page.value,
        nextCursor: encodeFrontierCursor(handoverFrontier()),
      });
    }
    const collected = await Result.tryPromise({
      try: async () => await collectFrontierPage(frontier, signal),
      catch: adapterCatch(ADAPTER_KEYS.SK_COURTS, cursor),
    });
    return collected.andThen((page) => page);
  },
});

/**
 * The oldest-first sweep of the whole collection, and only that.
 *
 * Walking this source newest-first from the start cannot catch up: it
 * publishes continuously, and each new decision shifts every later offset, so
 * items slide past the cursor unseen. Oldest-first converges because new
 * decisions land at the end, behind the cursor — and when it reaches that
 * end, the frontier takes over.
 */
const createBackfillPage = (
  readCourt: SkCourtRegistryReader,
  readDetail: SkCourtsDetailReader,
) =>
  createPagePaginatedFetch<SkApiResponse>({
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    pageSize: PAGE_SIZE,
    legacyPageSize: LEGACY_PAGE_SIZE,
    firstPage: FIRST_PAGE,
    listTimeoutMs: 60_000,
    itemConcurrency: ITEM_CONCURRENCY,

    buildRequest: (page) => listRequest(page, "ASC"),

    traversal: [
      {
        name: "backfill",
        buildRequest: (page) => listRequest(page, "ASC"),
        followedBy: FRONTIER_PHASE,
      },
    ],

    parseResponse: async (response) => {
      const bytes =
        response.body === null
          ? new Uint8Array()
          : await readCappedBytes(response.body, PUBLISHER_BODY_MAX_BYTES);
      if (bytes === null) {
        return Result.err(
          new AdapterFetchError({
            message: `SK courts listing exceeded ${PUBLISHER_BODY_MAX_BYTES} bytes`,
            adapterKey: ADAPTER_KEYS.SK_COURTS,
            cursor: null,
          }),
        );
      }
      const validatedPage = validatePublisherPage({
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        cursor: null,
        headers: response.headers,
        body: new TextDecoder().decode(bytes),
        expectation: {
          kind: "json",
          minBytes: 2,
          shape: isSkApiResponse,
        },
      });
      if (validatedPage.isErr()) {
        throw validatedPage.error;
      }
      const json = validatedPage.value;
      if (!isSkApiResponse(json)) {
        return panic("Validated Slovak court listing has an invalid envelope");
      }
      const courtIds = new Set(
        arrayOrEmpty(json.rozhodnutieList).flatMap((item) => {
          if (!isSkApiItem(item) || skCourtsIdentityFields(item) === null) {
            return [];
          }
          const id = item.sud?.registreGuid;
          return id === null || id === undefined ? [] : [id];
        }),
      );
      const records = await mapWithConcurrency({
        items: [...courtIds],
        limit: ITEM_CONCURRENCY,
        operation: async (id) => await readCourt(id),
      });
      for (const record of records) {
        if (record.isErr()) {
          return record;
        }
      }
      await readPageDetails({
        items: arrayOrEmpty(json.rozhodnutieList),
        readDetail,
      });
      return Result.ok(json);
    },

    extractItems: (data) => ({
      items: arrayOrEmpty(data.rozhodnutieList),
      total: toOptionalValue(data.numFound),
    }),

    parseItem: async (item, signal) =>
      await parseItemWithDetail(item, { signal, readCourt, readDetail }),
  });
