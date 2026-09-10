/**
 * Polish Supreme Court (Sąd Najwyższy) adapter.
 *
 * sn.pl publishes the court's own decision database through a Joomla AJAX
 * proxy in front of an Elasticsearch-backed API. The court's search page
 * (`/pl/wyszukiwarka-orzeczen`) drives it with three tasks, and this adapter
 * uses the same three:
 *
 *   searchOrzeczenia    listing, filtered by `data_wydania_od`/`_do`,
 *                       paged by `strona` (1-based) and `rozmiar_strony`
 *   detailsOrzeczenie   the chamber, the bench and the modification date
 *   OrzeczeniePlikPdf   the decision itself, base64 inside a JSON envelope
 *
 * Two properties of that API shape everything below.
 *
 * It states no result total — the court's own page says so and renders "next"
 * for as long as a page comes back full — so a walk ends when the publisher
 * serves a short page, never on a missing count.
 *
 * And it refuses to page past the 10,000th match of a query, answering an
 * Elasticsearch window error wrapped in a 200. The crawl therefore windows by
 * calendar month: the busiest month observed holds between 2,000 and 2,400
 * decisions, so the cap sits about four times above the corpus's own peak,
 * and a year window (already past 10,000 in 2025) is not an option.
 *
 * Cursor format: `YYYY-MM:offset` — the month being walked and the item
 * offset reached inside it. Oldest-first, so a decision published later
 * appends past the cursor rather than shifting the offsets already walked;
 * at the present month the cursor parks and re-reads only that month's tail.
 *
 * Overlap with `pl-courts`: SAOS republished this court until 2016-06-22 and
 * its importer has been dormant since. The two sources have separate id
 * spaces and are not deduplicated here.
 */

import { Result, panic } from "better-result";

import { Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  decodeSourceRawEnvelope,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { createPublisherRequestSlot } from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parsePlSnDecisionPdf } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const PROXY_URL = "https://sn.pl/pl/index.php";

/**
 * The only origin this adapter may reach. Every URL it fetches is built here
 * from an opaque publisher id, and the check below is what keeps it that way
 * if a payload ever supplies one.
 */
const PL_SN_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://sn.pl"],
} as const;

const PROXY_TASK = {
  SEARCH: "searchOrzeczenia",
  DETAILS: "detailsOrzeczenie",
  DOCUMENT: "OrzeczeniePlikPdf",
} as const;

type ProxyTask = (typeof PROXY_TASK)[keyof typeof PROXY_TASK];

/**
 * Shortest gap between two requests to this publisher.
 *
 * The proxy rate-limits: a dozen requests in quick succession earned
 * `{"error":"Brak tokenu","debug":{"json_status":429}}` — the upstream's 429
 * dressed up as a missing token — and the same pacing then answered normally.
 * A second is the floor this adapter holds to, across the listing, the detail
 * and the document alike, through one shared slot.
 */
const MIN_REQUEST_INTERVAL_MS = 1000;

const reservePlSnRequestSlot = createPublisherRequestSlot({
  intervalMs: MIN_REQUEST_INTERVAL_MS,
  key: "case-law:publisher-gate:sn-pl",
  publisher: "Sąd Najwyższy",
});

/**
 * Decisions the crawl lists at a time.
 *
 * Small, because every listed item it keeps costs a detail request and a
 * document request behind the same one-second gate: twenty items is about
 * forty requests, which is a page that finishes inside its timeout.
 */
const CRAWL_PAGE_SIZE = 20;

/**
 * Decisions a reconciliation listing asks for at a time. Five times the
 * crawl's, because a listing walk fetches no documents, and the endpoint was
 * observed honouring 100.
 */
const LISTING_PAGE_SIZE = 100;

/** The publisher numbers listing pages from one. */
const FIRST_PAGE = 1;

/** The only language this source publishes; half of the fallback identity. */
const PL_SN_LANGUAGE = "pl";

const PL_SN_DATE_RANGE = ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_SN].dateRange;

/** Oldest decision date the search answers with; see the manifest. */
const PL_SN_FIRST_SLICE = PL_SN_DATE_RANGE.fromInclusive;

/** The month that first slice falls in, where a fresh crawl starts. */
const PL_SN_FIRST_MONTH = PL_SN_FIRST_SLICE.slice(0, 7);

/**
 * Slices near the tip the reconciliation re-walks on a fast cadence.
 *
 * A slice is a decision date, and this court publishes against a date for
 * weeks after it: `data_modyfikacji` on a decision handed down in 1993 reads
 * 2025. A fortnight is the active frontier, not the whole fill-in window; what
 * reaches a later arrival is the ledger re-selecting a slice recorded short.
 */
const PL_SN_TIP_WINDOW_DAYS = 14;

/**
 * Consecutive empty months one `fetchPage` may step over before it banks the
 * progress it made.
 *
 * A month with no decisions is a definitive answer about that month, so
 * stepping past it needs no new cycle — but a cold start at 1993 would
 * otherwise spend one cycle per empty month, and the early years are nearly
 * all empty. Twelve keeps a page bounded (thirteen requests, thirteen
 * seconds) while a full sweep to the present converges in a few dozen pages
 * rather than a few hundred.
 */
const MAX_EMPTY_MONTH_SKIPS = 12;

// ── Publisher payloads ───────────────────────────────────

/** One decision as the listing states it. */
export type PlSnListingItem = {
  sygnatura_sprawy?: string | undefined;
  data_wydania?: string | undefined;
  forma_orzeczenia?: string | undefined;
  id?: string | undefined;
};

/** One decision as `detailsOrzeczenie` states it. */
type PlSnDetail = PlSnListingItem & {
  jednostka_obslugujaca_sprawe?: string | undefined;
  izby_sn?: string[] | undefined;
  rodzaj_skladu_orzekajacego?: string | undefined;
  sklad_orzekajacy?: string[] | undefined;
  sklad_orzekajacy_przewodniczacy?: string[] | undefined;
  sklad_orzekajacy_sprawozdawca?: string[] | undefined;
  sklad_orzekajacy_wspolsprawozdawcy?: string[] | undefined;
  sklad_orzekajacy_autor_uzasadnienia?: string | undefined;
  zglaszajacy_zdanie_odrebne_orzeczenie?: string | undefined;
  zglaszajacy_zdanie_odrebne_uzasadnienie?: string | undefined;
  data_modyfikacji?: string | undefined;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const optionalStringArray = (value: unknown): string[] | undefined =>
  isStringArray(value) && value.length > 0 ? value : undefined;

/**
 * Read a listing row leniently: the proxy adds fields without notice and all
 * of them land in JSONB, so only the shape of what is read here is checked.
 */
export const normalizePlSnListingItem = (
  value: Record<string, unknown>,
): PlSnListingItem => ({
  sygnatura_sprawy: optionalString(value["sygnatura_sprawy"]),
  data_wydania: optionalString(value["data_wydania"]),
  forma_orzeczenia: optionalString(value["forma_orzeczenia"]),
  id: optionalString(value["id"]),
});

const normalizePlSnDetail = (value: Record<string, unknown>): PlSnDetail => ({
  ...normalizePlSnListingItem(value),
  jednostka_obslugujaca_sprawe: optionalString(
    value["jednostka_obslugujaca_sprawe"],
  ),
  izby_sn: optionalStringArray(value["izby_sn"]),
  rodzaj_skladu_orzekajacego: optionalString(
    value["rodzaj_skladu_orzekajacego"],
  ),
  sklad_orzekajacy: optionalStringArray(value["sklad_orzekajacy"]),
  sklad_orzekajacy_przewodniczacy: optionalStringArray(
    value["sklad_orzekajacy_przewodniczacy"],
  ),
  sklad_orzekajacy_sprawozdawca: optionalStringArray(
    value["sklad_orzekajacy_sprawozdawca"],
  ),
  sklad_orzekajacy_wspolsprawozdawcy: optionalStringArray(
    value["sklad_orzekajacy_wspolsprawozdawcy"],
  ),
  sklad_orzekajacy_autor_uzasadnienia: optionalString(
    value["sklad_orzekajacy_autor_uzasadnienia"],
  ),
  zglaszajacy_zdanie_odrebne_orzeczenie: optionalString(
    value["zglaszajacy_zdanie_odrebne_orzeczenie"],
  ),
  zglaszajacy_zdanie_odrebne_uzasadnienie: optionalString(
    value["zglaszajacy_zdanie_odrebne_uzasadnienie"],
  ),
  data_modyfikacji: optionalString(value["data_modyfikacji"]),
});

/**
 * The payload inside the proxy's two nested envelopes, or `null` for anything
 * that is not one.
 *
 * The proxy answers HTTP 200 whatever the upstream said: a rate limit comes
 * back as `{"message":401,"data":{"error":"Brak tokenu"}}` and an over-deep
 * page as an RFC 9110 error object where the records should be. Neither is an
 * empty result, so this returns the inner value and lets each caller state
 * what shape it requires — an unrecognised one is a failure, never a slice
 * with nothing in it.
 */
export const readPlSnEnvelope = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return null;
  }
  const outer = value["data"];
  if (!Array.isArray(outer)) {
    return null;
  }
  const inner: unknown = outer.at(0);
  return isRecord(inner) && "data" in inner ? inner["data"] : null;
};

// ── Requests ─────────────────────────────────────────────

const proxyUrl = (task: ProxyTask, params: Record<string, string>): string =>
  `${PROXY_URL}?${new URLSearchParams({
    option: "com_ajax",
    plugin: "snproxy",
    format: "json",
    task,
    ...params,
  }).toString()}`;

type ProxyRequestOptions = {
  cursor: string;
  params: Record<string, string>;
  signal?: AbortSignal | undefined;
  task: ProxyTask;
  timeoutMs: number;
};

const proxyError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `sn.pl: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_SN,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

type ProxyResponse = {
  /** The response body verbatim, for the stored raw envelope. */
  raw: string;
  /** The value inside the proxy's two envelopes. */
  payload: unknown;
  /** The URL that answered, for a recorded fixture's provenance. */
  url: string;
};

/**
 * One proxy request: its verbatim body, and the payload inside the envelope.
 *
 * Every refusal this function can recognise comes back as an `Err`. What it
 * cannot recognise — a dropped connection, an exhausted retry budget, a
 * cycle abort — is raised by `fetchWithRetry` and converted once, where the
 * caller's own contract says how a failure is reported.
 */
const requestProxy = async ({
  cursor,
  params,
  signal,
  task,
  timeoutMs,
}: ProxyRequestOptions): Promise<Result<ProxyResponse, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_SN_HOST_POLICY,
    rawUrl: proxyUrl(task, params),
  });
  if (target === null) {
    // Every URL here is built from a fixed origin and an opaque publisher id,
    // so a rejection means the construction above changed, not the publisher.
    return panic("sn.pl request escaped the publisher origin");
  }

  const response = await fetchWithRetry(
    target.toString(),
    { headers: { Accept: "application/json" }, redirect: "error" },
    {
      adapterKey: ADAPTER_KEYS.PL_SN,
      beforeAttempt: async () => await reservePlSnRequestSlot(signal),
      signal,
      timeoutMs,
    },
  );
  if (!response.ok) {
    return Result.err(
      proxyError(
        cursor,
        `${task} answered ${response.status}`,
        response.status,
      ),
    );
  }

  const raw = await response.text();
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  const payload = readPlSnEnvelope(parsed);
  if (payload === null) {
    return Result.err(
      proxyError(cursor, `${task} answered no readable envelope`),
    );
  }
  return Result.ok({ raw, payload, url: target.toString() });
};

type ListWindowOptions = {
  cursor: string;
  from: string;
  offset: number;
  pageSize: number;
  signal?: AbortSignal | undefined;
  to: string;
};

type ListedWindow = {
  rows: Record<string, unknown>[];
  /** The listing request these rows came back from. */
  url: string;
};

/**
 * One page of the publisher's listing for a closed decision-date window.
 *
 * The offset has to land on a page boundary, because `strona` is a page
 * number and there is no per-item offset to ask for: every cursor this
 * adapter writes is a multiple of the page size it was written with.
 */
const listWindow = async ({
  cursor,
  from,
  offset,
  pageSize,
  signal,
  to,
}: ListWindowOptions): Promise<Result<ListedWindow, AdapterFetchError>> => {
  const requested = await requestProxy({
    cursor,
    params: {
      data_wydania_od: from,
      data_wydania_do: to,
      strona: String(FIRST_PAGE + Math.floor(offset / pageSize)),
      rozmiar_strony: String(pageSize),
    },
    signal,
    task: PROXY_TASK.SEARCH,
    timeoutMs: ADAPTER_TIMEOUT.LIST,
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const { payload, url } = requested.value;

  // An array is the publisher's only statement about what a window holds; the
  // error object it answers past its 10,000-record window is not an empty one.
  if (!Array.isArray(payload)) {
    return Result.err(
      proxyError(
        cursor,
        `${PROXY_TASK.SEARCH} answered ${JSON.stringify(payload).slice(0, 200)} for ${from}..${to} at ${offset}`,
      ),
    );
  }
  const rows: unknown[] = payload;
  return Result.ok({ rows: rows.filter(isRecord), url });
};

type DecisionIdOptions = {
  cursor: string;
  id: string;
  signal?: AbortSignal | undefined;
};

const fetchDetail = async ({
  cursor,
  id,
  signal,
}: DecisionIdOptions): Promise<
  Result<{ detail: PlSnDetail; raw: string } | null, AdapterFetchError>
> => {
  const requested = await requestProxy({
    cursor,
    params: { id },
    signal,
    task: PROXY_TASK.DETAILS,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const { payload, raw } = requested.value;
  return Result.ok(
    isRecord(payload) ? { detail: normalizePlSnDetail(payload), raw } : null,
  );
};

/** Every PDF starts with this; nothing else the proxy serves does. */
const PDF_SIGNATURE_BYTES = new TextEncoder().encode("%PDF-");

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_SIGNATURE_BYTES.length &&
  PDF_SIGNATURE_BYTES.every((byte, index) => bytes[index] === byte);

/**
 * The decision's PDF, or `undefined` where the proxy served something else.
 *
 * The signature is checked because this proxy answers 200 with an error
 * object as readily as with a document: bytes taken on faith would be stored
 * as the decision's raw payload and read as the document by every replay.
 */
const decodePlSnDocument = (payload: unknown): Uint8Array | undefined => {
  const base64 = isRecord(payload) ? payload["raw"] : undefined;
  if (typeof base64 !== "string" || base64.length === 0) {
    return undefined;
  }
  const bytes = Result.try({
    try: () => Buffer.from(base64, "base64"),
    catch: () => null,
  }).unwrapOr(null);
  if (bytes === null) {
    return undefined;
  }
  const view = new Uint8Array(bytes);
  return isPdf(view) ? view : undefined;
};

const fetchDocument = async ({
  cursor,
  id,
  signal,
}: DecisionIdOptions): Promise<
  Result<{ bytes: Uint8Array; raw: string } | undefined, AdapterFetchError>
> => {
  const requested = await requestProxy({
    cursor,
    params: { id },
    signal,
    task: PROXY_TASK.DOCUMENT,
    timeoutMs: ADAPTER_TIMEOUT.PAGE,
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const { payload, raw } = requested.value;
  const bytes = decodePlSnDocument(payload);
  return Result.ok(bytes === undefined ? undefined : { bytes, raw });
};

// ── Normalization ────────────────────────────────────────

const PL_SN_COURT = "Sąd Najwyższy";

/**
 * The benches this publisher names, and the court each of them is.
 *
 * The deciding body is stated in `forma_orzeczenia`, which every listed form
 * ends with: "… SN" for the court sitting in its ordinary composition and
 * "… SN SD" for it sitting as the disciplinary court. Both are the Supreme
 * Court — the disciplinary bench is a composition of it, not a court of its
 * own, and a citation names neither differently — so the distinction is kept
 * on the row as the form rather than invented into a second court name.
 */
const PL_SN_BENCH_COURTS = {
  SN: PL_SN_COURT,
  "SN SD": PL_SN_COURT,
} as const;

type PlSnBench = keyof typeof PL_SN_BENCH_COURTS;

const benchOf = (form: string): PlSnBench | null => {
  const tokens = form.split(/\s+/u);
  const marker = tokens.indexOf("SN");
  if (marker === -1) {
    return null;
  }
  return tokens[marker + 1] === "SD" ? "SN SD" : "SN";
};

/**
 * The deciding court, read off the record's own decision form.
 *
 * A form naming no bench is reported rather than assumed: this portal is the
 * court's own, but a publisher that starts carrying another body's decisions
 * must not have them silently stored under this court's name, and the four
 * bare forms it lists today ("orzeczenie", "zarządzenie", "opinia", "wyciąg z
 * protokołu") are the shape such a change would arrive in.
 */
export const plSnDecidingCourt = (form: string | undefined): string => {
  const bench = form === undefined ? null : benchOf(form);
  if (bench === null) {
    logger.warn("case_law.ingestion.court_not_stated", {
      adapterKey: ADAPTER_KEYS.PL_SN,
      decisionForm: form ?? "",
    });
    return PL_SN_COURT;
  }
  return PL_SN_BENCH_COURTS[bench];
};

/**
 * Decision types in the court's own language, as rule 8 requires. The
 * publisher's `forma_orzeczenia` prefixes one of these to the bench and the
 * panel size, and the full string stays on the row as `decisionForm`.
 */
const PL_SN_DECISION_TYPES = [
  "wyrok",
  "postanowienie",
  "uchwała",
  "zarządzenie",
  "orzeczenie",
  "opinia",
  "wyciąg z protokołu",
] as const;

export const plSnDecisionType = (
  form: string | undefined,
): string | undefined => {
  if (form === undefined) {
    return undefined;
  }
  const lowered = form.toLocaleLowerCase("pl-PL");
  const matched = PL_SN_DECISION_TYPES.find(
    (type) => lowered === type || lowered.startsWith(`${type} `),
  );
  if (matched === undefined) {
    logger.warn("case_law.ingestion.decision_type_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_SN,
      decisionForm: form,
    });
  }
  return matched;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const isoDate = (value: string | undefined): string | undefined =>
  value !== undefined && ISO_DATE.test(value) ? value : undefined;

/**
 * The identity the ingest stores this listing item under.
 *
 * The publisher's own document id. A Supreme Court docket is unique within
 * this court, but the id is what the portal keys a document on and what its
 * detail and document tasks are addressed by, so it is what identifies a row
 * (rule 17). Stated once so the crawl and the reconciliation cannot key the
 * same item differently.
 */
export const plSnListingIdentity = (item: PlSnListingItem): ListingIdentity => {
  const { id } = item;
  if (id !== undefined && isPersistableSourceDocumentId(id)) {
    return { type: "document", sourceDocumentId: id };
  }
  const caseNumber = item.sygnatura_sprawy;
  return caseNumber === undefined
    ? { type: "unidentifiable" }
    : { type: "case-number", caseNumber, language: PL_SN_LANGUAGE };
};

const decisionUrl = (id: string): string =>
  `https://sn.pl/pl/wyszukiwarka-orzeczen?orzeczenie=${encodeURIComponent(id)}`;

const documentUrlOf = (id: string): string =>
  proxyUrl(PROXY_TASK.DOCUMENT, { id });

type PlSnBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No id and no docket to key on; nothing can store this item. */
  | { type: "unkeyable" }
  /** The proxy served no document for the id the listing states. */
  | { type: "detail-unavailable"; decision: IngestionResult };

/**
 * The parts of the stored raw envelope, named by the response each holds.
 * A replay reads exactly what a crawl kept, so the names are the contract.
 */
const RAW_PART = {
  LISTING: "listing",
  DETAIL: "detail",
  DOCUMENT: "document",
} as const;

type AssemblePlSnDecisionOptions = {
  /** The row as the listing stated it. */
  item: PlSnListingItem;
  /** The detail record, where one was read. */
  detail: PlSnDetail | null;
  /** The document's bytes, where the proxy served one. */
  documentBytes: Uint8Array | undefined;
  /** Every response this observation was built from, verbatim. */
  rawParts: SourceRawParts;
};

/**
 * Build one decision from the responses already in hand.
 *
 * No I/O: the crawl, the reconciliation walk and a replay of the stored
 * envelope all reach this with the same three payloads, so none of them can
 * key, parse or enrich an item differently from the others.
 */
const assemblePlSnDecision = async ({
  detail,
  documentBytes,
  item,
  rawParts,
}: AssemblePlSnDecisionOptions): Promise<PlSnBuildResult> => {
  const { id } = item;
  if (id === undefined || !isPersistableSourceDocumentId(id)) {
    return { type: "unkeyable" };
  }
  // Annotated because the union of the two payloads hides the detail-only
  // fields below; a listing row simply states none of them.
  const record: PlSnDetail = detail ?? item;
  const caseNumber = record.sygnatura_sprawy ?? item.sygnatura_sprawy;
  if (caseNumber === undefined) {
    return { type: "unkeyable" };
  }

  const decisionForm = record.forma_orzeczenia ?? item.forma_orzeczenia;
  const court = plSnDecidingCourt(decisionForm);
  const decisionType = plSnDecisionType(decisionForm);
  const decisionDate = isoDate(record.data_wydania ?? item.data_wydania);

  // A parse failure is deliberately not the decision's failure: the document
  // is stored verbatim below, so its text is recoverable by re-parsing what
  // was kept rather than by asking the court again. The error is carried as
  // its structural tag, which is all the report below states about it.
  const parsed =
    documentBytes === undefined
      ? null
      : await Result.tryPromise({
          try: async () =>
            await parsePlSnDecisionPdf({
              pdfBytes: documentBytes,
              caseNumber,
              court,
              decisionDate,
              decisionType,
              sourceUrl: decisionUrl(id),
              documentUrl: documentUrlOf(id),
              documentId: id,
            }),
          catch: errorTag,
        });
  if (parsed !== null && Result.isError(parsed)) {
    logger.warn("case_law.ingestion.document_parse_failed", {
      adapterKey: ADAPTER_KEYS.PL_SN,
      caseNumber,
      "error.type": parsed.error,
    });
  }
  const document = parsed !== null && Result.isOk(parsed) ? parsed.value : null;
  const documentAst: DocumentAst | EmptyAst =
    document?.documentAst ?? EMPTY_AST;
  const fulltext = document?.fulltext;

  const sourceRaw = encodeSourceRawEnvelope(rawParts);

  const decision: IngestionResult = {
    caseNumber,
    sourceDocumentId: id,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_SN].country,
    language: PL_SN_LANGUAGE,
    decisionDate,
    decisionType,
    fulltext,
    // The listing proves the document exists; without it this row carries
    // metadata only and must never overwrite detail a later fetch recovered.
    ...(documentBytes === undefined ? { isListingOnly: true } : {}),
    sourceUrl: decisionUrl(id),
    documentUrl: documentUrlOf(id),
    // sn.pl publishes no abstract, headnote or legal sentence beside the
    // decision; the thesis it prints is inside the document itself.
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court,
      decisionDate,
      decisionType,
      decisionForm,
      documentId: id,
      chambers: record.izby_sn,
      handlingUnit: record.jednostka_obslugujaca_sprawe,
      panelType: record.rodzaj_skladu_orzekajacego,
      judges: record.sklad_orzekajacy,
      presiding: record.sklad_orzekajacy_przewodniczacy,
      reporters: record.sklad_orzekajacy_sprawozdawca,
      coReporters: record.sklad_orzekajacy_wspolsprawozdawcy,
      reasonsAuthor: record.sklad_orzekajacy_autor_uzasadnienia,
      dissentingOnDecision: record.zglaszajacy_zdanie_odrebne_orzeczenie,
      dissentingOnReasons: record.zglaszajacy_zdanie_odrebne_uzasadnienie,
      modifiedDate: record.data_modyfikacji,
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_SN],
    documentAst,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };

  return documentBytes === undefined
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

type FetchPlSnDecisionOptions = {
  cursor: string;
  item: PlSnListingItem;
  /** Verbatim listing row, kept so a later parser can re-read it. */
  listingRaw: string;
  signal?: AbortSignal | undefined;
};

/**
 * Fetch the detail and the document for a listed item, then assemble it.
 *
 * A refused request is the item's failure rather than its absence: the
 * publisher was asked and did not answer, so the caller holds its cursor and
 * asks again instead of storing a row that says the document does not exist.
 */
export const buildPlSnDecision = async ({
  cursor,
  item,
  listingRaw,
  signal,
}: FetchPlSnDecisionOptions): Promise<
  Result<PlSnBuildResult, AdapterFetchError>
> => {
  const { id } = item;
  if (id === undefined || !isPersistableSourceDocumentId(id)) {
    return Result.ok({ type: "unkeyable" });
  }

  const fetched = await fetchDetail({ cursor, id, signal });
  if (Result.isError(fetched)) {
    return fetched;
  }
  const requested = await fetchDocument({ cursor, id, signal });
  if (Result.isError(requested)) {
    return requested;
  }
  const detail = fetched.value;
  const document = requested.value;

  return Result.ok(
    await assemblePlSnDecision({
      item,
      detail: detail?.detail ?? null,
      documentBytes: document?.bytes,
      rawParts: {
        [RAW_PART.LISTING]: listingRaw,
        ...(detail === null ? {} : { [RAW_PART.DETAIL]: detail.raw }),
        ...(document === undefined
          ? {}
          : { [RAW_PART.DOCUMENT]: document.raw }),
      },
    }),
  );
};

/**
 * Re-parse a stored envelope into the decision this adapter would build from
 * it today, without contacting the publisher.
 *
 * The envelope holds every response the crawl read, so a parser change is
 * replayable across the corpus; a row stored before the adapter wrote an
 * envelope decodes to `null` and is reported rather than guessed at.
 */
const reparsePlSnStoredRaw = async (
  stored: StoredRawReparseInput,
): Promise<StoredRawReparseOutcome> => {
  if (stored.contentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored under ${stored.contentType ?? "no content type"}`,
    };
  }
  const parts = decodeSourceRawEnvelope(new TextDecoder().decode(stored.raw));
  const listingRaw = parts?.[RAW_PART.LISTING];
  if (parts === null || listingRaw === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "the stored payload holds no listing row",
    };
  }

  const listing = Result.try({
    try: (): unknown => JSON.parse(listingRaw),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(listing)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail: "the stored listing row is not an object",
    };
  }

  const item = normalizePlSnListingItem(listing);
  if (item.id !== stored.sourceDocumentId) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `the envelope names ${item.id ?? "no id"}, the row ${stored.sourceDocumentId ?? "none"}`,
    };
  }

  const detailPart = parts[RAW_PART.DETAIL];
  const detailPayload =
    detailPart === undefined
      ? null
      : readPlSnEnvelope(
          Result.try({
            try: (): unknown => JSON.parse(detailPart),
            catch: () => null,
          }).unwrapOr(null),
        );
  const documentPart = parts[RAW_PART.DOCUMENT];
  const documentPayload =
    documentPart === undefined
      ? null
      : readPlSnEnvelope(
          Result.try({
            try: (): unknown => JSON.parse(documentPart),
            catch: () => null,
          }).unwrapOr(null),
        );

  const built = await assemblePlSnDecision({
    item,
    detail: isRecord(detailPayload) ? normalizePlSnDetail(detailPayload) : null,
    documentBytes:
      documentPayload === null
        ? undefined
        : decodePlSnDocument(documentPayload),
    rawParts: parts,
  });
  return built.type === "unkeyable"
    ? {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: "the stored listing row states no id or docket",
      }
    : { type: "parsed", result: built.decision };
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every field `detailsOrzeczenie` labels for one decision. The listing states
 * a subset of the same names, so this list covers both per-decision payloads
 * the adapter parses.
 */
const SOURCE_FIELDS = [
  "sygnatura_sprawy",
  "data_wydania",
  "forma_orzeczenia",
  "id",
  "izby_sn",
  "jednostka_obslugujaca_sprawe",
  "rodzaj_skladu_orzekajacego",
  "sklad_orzekajacy",
  "sklad_orzekajacy_przewodniczacy",
  "sklad_orzekajacy_sprawozdawca",
  "sklad_orzekajacy_wspolsprawozdawcy",
  "sklad_orzekajacy_autor_uzasadnienia",
  "zglaszajacy_zdanie_odrebne_orzeczenie",
  "zglaszajacy_zdanie_odrebne_uzasadnienie",
  "data_modyfikacji",
] as const;

const PL_SN_SOURCE_FIELDS = {
  sygnatura_sprawy: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  data_wydania: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  // The form also carries the bench the court's name is read off; the
  // decision type derived from it is a second reading of the same field.
  forma_orzeczenia: {
    disposition: "stored",
    target: { type: "metadata", key: "decisionForm" },
  },
  id: { disposition: "stored", target: { type: "identity" } },
  izby_sn: {
    disposition: "stored",
    target: { type: "metadata", key: "chambers" },
  },
  jednostka_obslugujaca_sprawe: {
    disposition: "stored",
    target: { type: "metadata", key: "handlingUnit" },
  },
  rodzaj_skladu_orzekajacego: {
    disposition: "stored",
    target: { type: "metadata", key: "panelType" },
  },
  sklad_orzekajacy: {
    disposition: "stored",
    target: { type: "metadata", key: "judges" },
  },
  sklad_orzekajacy_przewodniczacy: {
    disposition: "stored",
    target: { type: "metadata", key: "presiding" },
  },
  sklad_orzekajacy_sprawozdawca: {
    disposition: "stored",
    target: { type: "metadata", key: "reporters" },
  },
  sklad_orzekajacy_wspolsprawozdawcy: {
    disposition: "stored",
    target: { type: "metadata", key: "coReporters" },
  },
  sklad_orzekajacy_autor_uzasadnienia: {
    disposition: "stored",
    target: { type: "metadata", key: "reasonsAuthor" },
  },
  zglaszajacy_zdanie_odrebne_orzeczenie: {
    disposition: "stored",
    target: { type: "metadata", key: "dissentingOnDecision" },
  },
  zglaszajacy_zdanie_odrebne_uzasadnienie: {
    disposition: "stored",
    target: { type: "metadata", key: "dissentingOnReasons" },
  },
  data_modyfikacji: {
    disposition: "stored",
    target: { type: "metadata", key: "modifiedDate" },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

/** What the publisher labels on a detail payload it served. */
const listPlSnSourceFields = (payload: string): readonly string[] => {
  const inner = readPlSnEnvelope(
    Result.try({
      try: (): unknown => JSON.parse(payload),
      catch: () => null,
    }).unwrapOr(null),
  );
  return isRecord(inner) ? Object.keys(inner) : [];
};

// ── Crawl cursor ─────────────────────────────────────────

const CURSOR_PATTERN = /^(?<month>\d{4}-(?:0[1-9]|1[0-2])):(?<offset>\d+)$/u;

type PlSnCursor = { month: string; offset: number };

export const parsePlSnCursor = (cursor: string | null): PlSnCursor => {
  const groups =
    cursor === null ? undefined : CURSOR_PATTERN.exec(cursor)?.groups;
  const month = groups?.["month"];
  const offset = groups?.["offset"];
  if (month === undefined || offset === undefined) {
    return { month: PL_SN_FIRST_MONTH, offset: 0 };
  }
  const parsed = Number(offset);
  return Number.isSafeInteger(parsed)
    ? { month, offset: parsed }
    : { month, offset: 0 };
};

export const encodePlSnCursor = ({ month, offset }: PlSnCursor): string =>
  `${month}:${offset}`;

const currentMonth = (): string =>
  Temporal.Now.plainDateISO("UTC").toPlainYearMonth().toString();

const monthAfter = (month: string): string | null => {
  const next = Temporal.PlainYearMonth.from(month)
    .add({ months: 1 })
    .toString();
  return next > currentMonth() ? null : next;
};

/** The publisher's own filter bounds for a month: the month, end to end. */
const monthRange = (month: string): { from: string; to: string } => {
  const yearMonth = Temporal.PlainYearMonth.from(month);
  return {
    from: `${month}-01`,
    to: `${month}-${String(yearMonth.daysInMonth).padStart(2, "0")}`,
  };
};

// ── Reconciliation ───────────────────────────────────────

/**
 * A reconciliation slice is one decision date, which is the axis the search
 * filters on. `YYYY-MM-DD` sorts lexicographically in chronological order,
 * which is the ordering the ledger relies on.
 */
const plSnDaySlices = createCalendarDaySliceWalk({
  firstSlice: PL_SN_FIRST_SLICE,
  source: ADAPTER_KEYS.PL_SN,
});

/**
 * One page of the publisher's listing for a decision date.
 *
 * The API states no total, so the page count cannot be computed from one: a
 * full page is reported as "there is at least one more", and the walk ends
 * only where the publisher itself serves a short page. Ending on a full page
 * with no continuation token would silently drop the remainder (rule 14); a
 * short page is the source's own statement that the slice is done.
 */
const listPlSnSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const listed = await listWindow({
    cursor: slice,
    from: slice,
    offset: page * LISTING_PAGE_SIZE,
    pageSize: LISTING_PAGE_SIZE,
    signal,
    to: slice,
  });
  if (Result.isError(listed)) {
    // A slice listing reports its publisher through the promise it returns:
    // the reconciliation engine holds the slice's previous ledger row on a
    // rejection, and would settle the slice over the outage if a refusal came
    // back as a page instead.
    return await Promise.reject(listed.error);
  }
  const { rows } = listed.value;

  const items = rows.map((row) => {
    const item = normalizePlSnListingItem(row);
    return {
      identity: plSnListingIdentity(item),
      payload: row,
    };
  });

  if (items.length === 0) {
    return { items, totalPages: page };
  }
  return {
    items,
    totalPages: items.length < LISTING_PAGE_SIZE ? page + 1 : page + 2,
  };
};

/**
 * Rebuild a decision from a payload the loop stored verbatim.
 *
 * Renormalized rather than trusted: it may have been parked for days, and a
 * shape the adapter no longer recognises has to be reported as unbuildable
 * instead of parsed on faith.
 */
const buildPlSnFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const item = normalizePlSnListingItem(payload);
  const attempted = await buildPlSnDecision({
    cursor: item.data_wydania ?? "",
    item,
    listingRaw: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal }),
  });
  if (Result.isError(attempted)) {
    // Same contract as the slice listing above: the engine reads a refused
    // item off the promise, and reporting it as an outcome would mark the
    // identity handled while the publisher never answered for it.
    return await Promise.reject(attempted.error);
  }
  const built = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    case "detail-unavailable":
      // Storing the listing observation here would make the identity held
      // while its document stayed unread, and the decision would leave every
      // later reconciliation.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-sn build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Crawl ────────────────────────────────────────────────

type CrawlWindow = {
  month: string;
  offset: number;
  rows: Record<string, unknown>[];
  /** The listing request the rows came back from. */
  url: string;
};

/**
 * The next month holding decisions at or after the cursor, with its first
 * page of rows.
 *
 * An empty month is a settled fact about that month, so the walk steps over
 * it inside one page rather than spending a cycle on each. The step is
 * bounded: past the budget the page banks where it got to, and the next cycle
 * carries on from there.
 */
const advanceToPopulatedWindow = async (
  start: PlSnCursor,
  signal?: AbortSignal,
): Promise<Result<CrawlWindow, AdapterFetchError>> => {
  let { month, offset } = start;
  let url = "";
  for (let step = 0; step <= MAX_EMPTY_MONTH_SKIPS; step += 1) {
    const { from, to } = monthRange(month);
    const listed = await listWindow({
      cursor: encodePlSnCursor({ month, offset }),
      from,
      offset,
      pageSize: CRAWL_PAGE_SIZE,
      signal,
      to,
    });
    if (Result.isError(listed)) {
      return listed;
    }
    url = listed.value.url;
    if (listed.value.rows.length > 0) {
      return Result.ok({ month, offset, rows: listed.value.rows, url });
    }
    const next = monthAfter(month);
    if (next === null) {
      // The present month, with nothing after this offset: park here so the
      // next cycle re-reads this month's tail and nothing older (rule 13).
      return Result.ok({ month, offset, rows: [], url });
    }
    month = next;
    offset = 0;
  }
  return Result.ok({ month, offset, rows: [], url });
};

const plSnFetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const advanced = await advanceToPopulatedWindow(
    parsePlSnCursor(cursor),
    signal,
  );
  if (Result.isError(advanced)) {
    return advanced;
  }
  const window = advanced.value;
  const decisions: IngestionResult[] = [];

  for (const row of window.rows) {
    if (signal?.aborted) {
      break;
    }
    const attempted = await buildPlSnDecision({
      cursor: encodePlSnCursor(window),
      item: normalizePlSnListingItem(row),
      listingRaw: JSON.stringify(row),
      signal,
    });
    if (Result.isError(attempted)) {
      return attempted;
    }
    const built = attempted.value;
    switch (built.type) {
      case "unkeyable":
        break;
      // The cursor moves past this document either way, so the crawl keeps
      // the listing-only row a document the proxy served nothing for still
      // describes; only the reconciliation refuses it.
      case "detail-unavailable":
      case "built":
        decisions.push(built.decision);
        break;
      default: {
        built satisfies never;
        panic(`Unhandled pl-sn build result: ${JSON.stringify(built)}`);
      }
    }
  }

  if (window.rows.length >= CRAWL_PAGE_SIZE) {
    return Result.ok({
      decisions,
      sourceUrl: window.url,
      nextCursor: encodePlSnCursor({
        month: window.month,
        offset: window.offset + window.rows.length,
      }),
    });
  }

  const next = monthAfter(window.month);
  return Result.ok({
    decisions,
    sourceUrl: window.url,
    nextCursor:
      next === null
        ? encodePlSnCursor(window)
        : encodePlSnCursor({ month: next, offset: 0 }),
  });
};

// ── Adapter ──────────────────────────────────────────────

export const plSnAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_SN,
  language: PL_SN_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // A page is one listing request plus a detail and a document request per
  // item, all behind the one-second gate, plus up to a dozen empty-month
  // steps ahead of them.
  pageTimeoutMs: 300_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparsePlSnStoredRaw,

  sourceFields: {
    status: "declared",
    fields: PL_SN_SOURCE_FIELDS,
    listSourceFields: listPlSnSourceFields,
  },

  /**
   * Known blind spot: the API states no result total. The court's own search
   * page says as much in its script and renders "next" for as long as a page
   * comes back full, so there is no count to read and no request that would
   * answer differently — an absence rather than a probe that failed.
   */
  async getTotalCount(_signal) {
    return await Promise.resolve({ type: "no-count-endpoint" });
  },

  reconciliation: {
    firstSlice: PL_SN_FIRST_SLICE,
    ...plSnDaySlices.walk,
    tipWindowDays: PL_SN_TIP_WINDOW_DAYS,
    // A document failure leaves a listing-only row behind; unset, that row
    // would count as held and its document would never be hunted again.
    heldRequiresDetail: true,
    listSlicePage: listPlSnSlicePage,
    buildDecision: buildPlSnFromPayload,
  },

  /**
   * The page's own refusals come back as `Err` from the walk; this wrapper is
   * for what the fetch layer raises instead of returning — a dropped
   * connection, an exhausted retry budget, a cycle abort.
   */
  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plSnFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_SN, cursor),
      }),
    );
  },
});
