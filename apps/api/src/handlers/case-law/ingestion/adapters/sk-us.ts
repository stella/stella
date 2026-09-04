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

import { Result, panic } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  defineSourceAdapter,
  EMPTY_AST,
  isPersistableSourceDocumentId,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationListingItem,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  AdapterFetchError,
  FetchBoundaryError,
} from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { parseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

// ── Constants ─────────────────────────────────────────────

const BASE_URL = "https://www.ustavnysud.sk";
const SEARCH_URL = `${BASE_URL}/o/v1/dms/search`;
const DOC_DOWNLOAD_URL = `${BASE_URL}/docDownload`;

const PAGE_SIZE = 10;
const SEARCH_RETRY_DELAY_MS = 500;

/**
 * Shortest gap between two requests this adapter makes to the court, both as
 * the pipeline's pacing and as the pause it takes between requests of its own.
 */
const MIN_REQUEST_INTERVAL_MS = 500;

/**
 * Page size for a listing walk. The crawl takes ten at a time because every
 * item it keeps costs a PDF download; a listing walk downloads nothing, so it
 * asks for the largest page the DMS was observed to honour (a 361-decision
 * month answers 100, 100, 100, 61).
 */
const LISTING_PAGE_SIZE = 100;

/** First year with decisions in the API. */
const FIRST_YEAR = 1993;

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

type YearCursor = { year: number; offset: number };

const parseCursor = (cursor: string | null): YearCursor => {
  if (!cursor) {
    return { year: FIRST_YEAR, offset: 0 };
  }

  // New format: "YYYY:offset"
  const match = /^(?<year>\d{4}):(?<offset>\d+)$/u.exec(cursor);
  const { year, offset } = match?.groups ?? {};
  if (year && offset) {
    return {
      year: Number.parseInt(year, 10),
      offset: Number.parseInt(offset, 10),
    };
  }

  // Legacy format: plain offset number (e.g. "3060").
  // The global offset is meaningless with year-windowed queries.
  // Restart from FIRST_YEAR to backfill the full 1993–present
  // archive (~52k decisions, takes a few hours to crawl through).
  const legacyOffset = Number.parseInt(cursor, 10);
  if (!Number.isNaN(legacyOffset)) {
    return { year: FIRST_YEAR, offset: 0 };
  }

  return { year: FIRST_YEAR, offset: 0 };
};

const encodeCursor = (c: YearCursor): string => `${c.year}:${c.offset}`;

// ── Search API types ─────────────────────────────────────

type SearchDocument = {
  documentId?: string;
  mkDocumentType?: string;
  mkRSAPNumberOfFile?: string;
  mkRVPNumberOfFile?: string;
  mkECLI?: string;
  mkDateOfDecision?: string;
  mkDateOfLegalForce?: string;
  mkPublicationDate?: string;
  mkFormOfDecision?: string;
  mkTypeOfDecision?: string[];
  mkTypeOfProceeding?: string;
  mkTypeOfNegotiation?: string[];
  mkDecisionInTermsOf?: string[];
  mkResultOfNegotiation?: string[];
  mkCause?: string[];
  mkJudgeReporter?: string;
  mkDifferentView?: string[];
  mkWordRegister?: string[];
  mkMaterialRegister?: string[];
  mkComplainedLegalRegulation?: string | string[];
  mkFileReference?: string[];
  mkReferences?: string[];
  mkTypeOfProposer?: string;
  mkAffectedLegalRegulation?: string;
  mkUnderage?: string;
  mkIncludeToZnaU?: boolean;
  mkEntryDate?: string;
  mkFormOfEntry?: string;
  mkTypeOfEntry?: string;
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
const parseApiDate = (raw: string | undefined): string | undefined => {
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

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_SIGNATURE_BYTES.length &&
  PDF_SIGNATURE_BYTES.every((byte, index) => bytes[index] === byte);

/**
 * The decision's PDF, or `undefined` when the court served no document.
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
): Promise<Uint8Array | undefined> => {
  try {
    const response = await fetchWithTimeout(
      `${DOC_DOWNLOAD_URL}/${documentId}`,
      {
        headers: { "User-Agent": INGESTION_USER_AGENT },
        signal,
        timeoutMs: 30_000,
      },
    );
    if (!response.ok) {
      return undefined;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return isPdf(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
};

// ── Item parsing ─────────────────────────────────────────

const dedupe = (arr: readonly string[] | undefined): string[] =>
  arr ? [...new Set(arr)] : [];

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
  | { type: "detail-unavailable"; decision: IngestionResult };

/**
 * Build one decision from a search-listing item, downloading and parsing its
 * PDF. Shared by the crawl and the reconciliation walk so neither can key,
 * parse or enrich an item differently from the other.
 */
export const buildSkUsDecision = async (
  doc: SearchDocument,
  signal?: AbortSignal,
): Promise<SkUsBuildResult> => {
  const fields = skUsIdentityFields(doc);
  if (fields === null) {
    return { type: "unkeyable" };
  }
  const { caseNumber, documentId } = fields;

  const decisionDate = parseApiDate(doc.mkDateOfDecision);
  const decisionType = doc.mkFormOfDecision?.toLowerCase();
  const ecli = doc.mkECLI;
  const court = "Ústavný súd SR";

  // Fetch and parse PDF
  const pdfBytes = await fetchPdfBytes(documentId, signal);

  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let fulltext: string | undefined;

  if (pdfBytes) {
    try {
      const parsed = await parseSkDecisionPdf({
        pdfBytes,
        caseNumber,
        ecli,
        court,
        decisionDate,
        decisionType,
        sourceSystem: "ustavnysud.sk",
      });
      documentAst = parsed.documentAst;
      fulltext = parsed.fulltext;
    } catch (error) {
      // The document itself came back and is stored verbatim, so its text is
      // recoverable by re-parsing what was kept rather than by asking the
      // court again. Reported rather than swallowed: a parser that starts
      // failing across a whole page is otherwise indistinguishable from
      // decisions that genuinely carry no text.
      logger.warn("case_law.ingestion.document_parse_failed", {
        adapterKey: ADAPTER_KEYS.SK_US,
        caseNumber,
        "error.type": errorTag(error),
      });
    }
  }

  const rawHash = hashContent(JSON.stringify(doc));
  const documentUrl = `${DOC_DOWNLOAD_URL}/${documentId}`;

  const decision: IngestionResult = {
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
    country: "SVK",
    language: SK_US_LANGUAGE,
    decisionDate,
    decisionType,
    fulltext,
    // The listing proves the document exists; without its PDF this row carries
    // metadata only, and must never overwrite detail a later fetch recovered.
    ...(pdfBytes === undefined ? { isListingOnly: true } : {}),
    sourceUrl: documentUrl,
    documentUrl,
    metadata: {
      caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      documentId,
      documentType: doc.mkDocumentType,
      rvpNumber: doc.mkRVPNumberOfFile,
      judge: doc.mkJudgeReporter,
      typeOfDecision: dedupe(doc.mkTypeOfDecision),
      typeOfProceeding: doc.mkTypeOfProceeding,
      typeOfNegotiation: dedupe(doc.mkTypeOfNegotiation),
      legalBasis: dedupe(doc.mkDecisionInTermsOf),
      result: dedupe(doc.mkResultOfNegotiation),
      cause: dedupe(doc.mkCause),
      dissentingOpinion: dedupe(doc.mkDifferentView),
      wordRegister: dedupe(doc.mkWordRegister),
      materialRegister: dedupe(doc.mkMaterialRegister),
      challengedLegislation: (() => {
        if (Array.isArray(doc.mkComplainedLegalRegulation)) {
          return doc.mkComplainedLegalRegulation;
        }
        if (doc.mkComplainedLegalRegulation) {
          return [doc.mkComplainedLegalRegulation];
        }
        return undefined;
      })(),
      legalForceDate: parseApiDate(doc.mkDateOfLegalForce),
      publicationDate: parseApiDate(doc.mkPublicationDate),
      references: doc.mkReferences,
      fileReference: doc.mkFileReference,
      typeOfProposer: doc.mkTypeOfProposer,
      affectedLegalRegulation: doc.mkAffectedLegalRegulation,
      underage: doc.mkUnderage,
      includeToZnaU: doc.mkIncludeToZnaU,
      entryDate: parseApiDate(doc.mkEntryDate),
      formOfEntry: doc.mkFormOfEntry,
      typeOfEntry: doc.mkTypeOfEntry,
    },
    rawHash,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_US],
    documentAst,
    sourceRaw: JSON.stringify(doc),
    sourceRawBytes: pdfBytes,
    sourceRawContentType: pdfBytes ? "application/pdf" : "application/json",
  };

  return pdfBytes === undefined
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

const executeSearch = async ({
  offset,
  pageSize,
  range,
  signal,
}: ExecuteSearchOptions): Promise<SearchResponse | null> => {
  const response = await fetchWithTimeout(SEARCH_URL, {
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

  if (!response.ok) {
    // A 401/403 here means the court put the endpoint back behind
    // authentication. There is no credential to refresh — the adapter
    // needs a real one — so surface it rather than retrying blind.
    throw new FetchBoundaryError({
      url: SEARCH_URL,
      status: response.status,
      statusText: response.statusText,
      message: `SK ÚS search failed: ${response.status}`,
    });
  }

  if (response.status === 204) {
    return null;
  }

  const data: unknown = await response.json();
  if (!isSearchResponse(data)) {
    const preview = JSON.stringify(data).slice(0, 200);
    panic(`SK ÚS search returned an invalid payload: ${preview}`);
  }

  return data;
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

const skUsSliceOf = (now: Date): string =>
  formatSlice({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

/** Step a slice by whole months, normalizing the year through UTC. */
const stepSlice = (slice: string, months: number): string => {
  const { month, year } = parseSlice(slice);
  return skUsSliceOf(new Date(Date.UTC(year, month - 1 + months, 1)));
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
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${slice}-01`, to: `${slice}-${String(lastDay)}` };
};

/**
 * One page of the publisher's own listing for a month, with no PDF downloads.
 *
 * A failed request is thrown, never flattened into an empty page. The crawl
 * can afford to read a 204 or a dead window as "nothing here" because a cursor
 * that moves on can be walked again; a ledger row cannot, since an outage
 * recorded as an empty month makes that month settled and it is never revisited.
 * So only a body that states a count answers what a month holds: `numFound: 0`
 * is an empty slice, and everything else — a 5xx (this endpoint has been
 * observed answering 500 and 524 under load), a 204, a body the validator
 * rejects — is an error the engine retries on a later pass.
 */
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

/** What one window of a month's results answered. */
type ListedWindow = {
  items: ReconciliationListingItem[];
  /** The month's size, from whichever sub-window stated it; null if none did. */
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
  /** 0-indexed result offset within the month. */
  offset: number;
  pageSize: number;
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

/** One search request for a window: its body, or null where it answered 204. */
const searchWindow = async ({
  offset,
  pageSize,
  signal,
  slice,
}: SearchWindowOptions): Promise<SearchResponse | null> => {
  const searchResult = await executeSearchWithRetry({
    cursor: slice,
    offset,
    pageSize,
    range: sliceDateRange(slice),
    signal,
  });
  if (Result.isError(searchResult)) {
    throw searchResult.error;
  }
  return searchResult.value;
};

const listedWindow = (data: SearchResponse): ListedWindow => ({
  items: data.documents.map((doc) => ({
    identity: skUsListingIdentity(doc),
    payload: doc,
  })),
  numFound: data.numFound,
});

/**
 * List one window of a month, splitting it around whatever the DMS refuses.
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
 * unidentifiable. The halving terminates at a window of one record, costs
 * {@link SPLIT_REQUESTS_PER_UNSERVED_RECORD} plus the one confirming request
 * below per such record, and each of those requests waits the same pause as
 * every other request here.
 *
 * A refusal that survives the halving with nothing served on either side is
 * the endpoint being down for that window rather than a record it cannot
 * serialise, and is thrown: reporting the window as that many unidentifiable
 * items would settle the month over an outage. Two unservable records lying
 * side by side read the same way and are refused with it, which is the safe
 * direction to be wrong in.
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
  signal,
  slice,
}: ListSkUsWindowOptions): Promise<ListedWindow> => {
  const data = await searchWindow({ offset, pageSize, signal, slice });
  if (data !== null) {
    return listedWindow(data);
  }

  if (pageSize <= 1) {
    await Bun.sleep(MIN_REQUEST_INTERVAL_MS);
    const confirmation = await searchWindow({
      offset,
      pageSize,
      signal,
      slice,
    });
    return confirmation === null
      ? { items: [unservedListingItem(offset)], numFound: null }
      : listedWindow(confirmation);
  }

  if (budget.remaining < 2) {
    throw unservedWindowError(
      slice,
      `splitting a refused window at offset ${offset} spent its ${SPLIT_REQUEST_BUDGET}-request budget`,
    );
  }
  budget.remaining -= 2;

  const half = Math.ceil(pageSize / 2);
  await Bun.sleep(MIN_REQUEST_INTERVAL_MS);
  const lower = await listSkUsWindow({
    budget,
    offset,
    pageSize: half,
    signal,
    slice,
  });
  await Bun.sleep(MIN_REQUEST_INTERVAL_MS);
  const upper = await listSkUsWindow({
    budget,
    offset: offset + half,
    pageSize: pageSize - half,
    signal,
    slice,
  });

  // Both halves state the size of the same month, so two different counts mean
  // the month changed under the walk or the endpoint answered about something
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
  if (numFound === null) {
    throw unservedWindowError(
      slice,
      `${pageSize} records from offset ${offset} served nothing`,
    );
  }

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
    signal,
    slice,
  });

  if (numFound === null) {
    // Only reachable where a page is one record wide: the split refuses a
    // wider window that served nothing before it can answer with one.
    throw unservedWindowError(slice, `offset ${page * LISTING_PAGE_SIZE}`);
  }

  return { items, totalPages: Math.ceil(numFound / LISTING_PAGE_SIZE) };
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
  const built = await buildSkUsDecision(payload, signal);
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    case "detail-unavailable":
      // The decision the listing describes is deliberately dropped: storing it
      // would make the identity held while its document stayed unread.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled SK ÚS build result: ${String(built)}`);
    }
  }
};

// ── Adapter ──────────────────────────────────────────────

export const skUsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.SK_US,
  name: "ustavnysud.sk",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,

  /**
   * Known blind spot: the court's decision search runs on a portal widget
   * whose search endpoint answers scripted requests with an empty 204 even
   * when replayed with browser-identical headers and session state, so the
   * total it shows in a browser cannot be read from here. Coverage for this
   * source is benchmarked only by what the crawl itself reports.
   *
   * Answered statically rather than probed: no request this adapter can make
   * would answer differently, so there is no failure to distinguish from the
   * absence.
   */
  async getTotalCount(_signal) {
    return await Promise.resolve({ type: "no-count-endpoint" });
  },

  /**
   * The DMS answers a decision-date range on its own, so what a month holds is
   * answerable without the crawl cursor ever reaching it: list the month, key
   * each item the way the ingest would, and compare against what is held.
   */
  reconciliation: {
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
    listSlicePage: listSkUsSlicePage,
    buildDecision: buildSkUsFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const { year, offset } = parseCursor(cursor);
        const currentYear = new Date().getFullYear();

        const searchResult = await executeSearchWithRetry({
          cursor,
          offset,
          pageSize: PAGE_SIZE,
          range: { from: `${year}-01-01`, to: `${year}-12-31` },
          signal,
        });
        if (Result.isError(searchResult)) {
          if (signal?.aborted) {
            throw new DOMException("Cycle aborted", "AbortError");
          }
          throw searchResult.error;
        }
        const data = searchResult.value;

        // 204 / empty search for this year window.
        // Advance to next year if available.
        if (!data || data.documents.length === 0) {
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

        for (const doc of data.documents) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- sequential per-document PDF download/parse, rate-limited via Bun.sleep below
            const built = await buildSkUsDecision(doc, signal);
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
              default: {
                built satisfies never;
                panic(`Unhandled SK ÚS build result: ${String(built)}`);
              }
            }
          } catch (error) {
            if (error instanceof DOMException) {
              throw error;
            }
            continue;
          }

          // Rate limit between PDF downloads
          // oxlint-disable-next-line no-await-in-loop -- deliberate crawl delay between sequential PDF downloads from the court server
          await Bun.sleep(300);
        }

        const nextOffset = offset + PAGE_SIZE;
        const hasMore =
          data.documents.length >= PAGE_SIZE && nextOffset < data.numFound;

        if (hasMore) {
          return {
            decisions,
            nextCursor: encodeCursor({ year, offset: nextOffset }),
          };
        }

        // Year exhausted — advance to next year or park
        if (year < currentYear) {
          return {
            decisions,
            nextCursor: encodeCursor({ year: year + 1, offset: 0 }),
          };
        }

        // Current year exhausted; park at current offset so the
        // pipeline's stagnation detection stops the cycle cleanly
        // instead of rewinding and reprocessing already-seen pages.
        return {
          decisions,
          nextCursor: encodeCursor({ year, offset }),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_US, cursor),
    });
  },
});
