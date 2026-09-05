import { panic } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import {
  defineSourceAdapter,
  EMPTY_AST,
  isPersistableSourceDocumentId,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  INGESTION_USER_AGENT,
  hashContent,
  isArrayOf,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  parseCeDate,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import { logger } from "@/api/lib/observability/logger";
import { sanitizeUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obcan.justice.sk REST API,
 * whose pages are numbered from one (see {@link FIRST_PAGE}).
 *
 * Each list item is enriched with a detail fetch for
 * ECLI, document URL, and referenced legislation.
 *
 * Cursor format: the walk and an item offset within it
 * ("backfill:1200", "live:0"); a bare "offset:100" predates
 * the walks and restarts the first of them.
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
/**
 * How far back the newest-first walk reaches before returning to the head.
 * Comfortably more than this source publishes between cycles, so a slow or
 * skipped cycle still cannot let a decision slip past unseen; already-stored
 * decisions in the overlap cost a list read and are then deduplicated.
 */
const LIVE_WINDOW_ITEMS = 5000;

/** The only language this source publishes; half of the fallback identity. */
export const SK_COURTS_LANGUAGE = "sk";

const arrayOrEmpty = <T>(value: T[] | null | undefined): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return value;
};

type SkSud = {
  registreGuid?: string | null;
  nazov?: string | null;
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
};

type SkDokument = {
  name?: string | null;
  fileExtension?: string | null;
  url?: string | null;
};

type SkOdkazovanyPredpis = {
  nazov?: string | null;
  url?: string | null;
};

type SkDetailItem = SkApiItem & {
  ecli?: string | null;
  podOblast?: string[] | null;
  odkazovanePredpisy?: SkOdkazovanyPredpis[] | null;
  dokument?: (SkDokument & { size?: number | null }) | null;
  updateDate?: string | null;
};

type SkApiResponse = {
  rozhodnutieList?: SkApiItem[] | null;
  numFound?: number | null;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOptionalNumber = (value: unknown): value is number | null | undefined =>
  isNullishNumber(value);

const isOptionalStringArray = (
  value: unknown,
): value is string[] | null | undefined =>
  value === undefined || value === null || isStringArray(value);

const isSkSud = (value: unknown): value is SkSud =>
  isRecord(value) &&
  isNullishString(value["registreGuid"]) &&
  isNullishString(value["nazov"]);

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
  isOptionalNumber(value["size"]);

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
  isOptionalStringArray(value["povaha"]);

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
    isOptionalStringArray(value["podOblast"]) &&
    isNullishArrayOf(value["odkazovanePredpisy"], isSkOdkazovanyPredpis) &&
    isNullishValue(value["dokument"], isSkDokument) &&
    isNullishString(value["updateDate"])
  );
};

const isSkApiResponse = (value: unknown): value is SkApiResponse =>
  isRecord(value) &&
  isNullishArrayOf(value["rozhodnutieList"], isSkApiItem) &&
  isOptionalNumber(value["numFound"]);

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
): Promise<SkDetailItem | null> => {
  const url = `${BASE_URL}/${encodeURIComponent(guid)}`;
  const response = await fetchWithTimeout(url, {
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    logger.warn("case_law.ingestion.detail_fetch_failed", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      guid,
      httpStatus: response.status,
    });
    return null;
  }

  const json: unknown = await response.json();
  if (!isSkDetailItem(json)) {
    return null;
  }
  return json;
};

/**
 * Build the public source URL for a decision.
 *
 * The infosud viewer (obcan.justice.sk/infosud/...) is a
 * Liferay portlet that frequently returns "item not found"
 * for valid decisions. Use the direct PDF content URL
 * instead — it's always available and is the actual document.
 */
const sourceUrlForDecision = (
  guid: string,
  documentUrl: string | null | undefined,
): string => documentUrl ?? `${BASE_URL}/${encodeURIComponent(guid)}`;

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
  const caseNumber = item.spisovaZnacka;
  const court = item.sud?.nazov;
  if (!caseNumber || !court) {
    return null;
  }
  return { caseNumber, court };
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
  return {
    type: "case-number",
    caseNumber: fields.caseNumber,
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
  /** A record was asked about and nothing came back. */
  | { type: "unavailable" };

const fetchDetailForItem = async (
  item: SkApiItem,
  signal?: AbortSignal,
): Promise<SkCourtsDetailFetch> => {
  const guid = toOptionalValue(item.guid);
  if (guid === undefined || guid.length === 0) {
    return { type: "listing-only" };
  }
  const detail = await fetchDetail(guid, signal);
  return detail === null ? { type: "unavailable" } : { type: "detail", detail };
};

type SkCourtsDecisionParts = {
  /** The item exactly as the publisher listed it. */
  item: SkApiItem;
  fields: SkCourtsIdentityFields;
  /** The per-decision record, where one was read. */
  detail: SkDetailItem | null;
};

const buildDecisionFromParts = ({
  detail,
  fields: { caseNumber, court },
  item,
}: SkCourtsDecisionParts): IngestionResult => {
  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
  const rawJson = JSON.stringify(item);
  const rawHash = hashContent(rawJson);

  // PDF download is deferred to the document walk in the
  // ingestion worker (lib/legal-search/sk-document-backfill.ts,
  // ordered by lib/legal-search/sk-document-queue.ts).
  // Metadata-only ingestion (list + detail) lets us fly
  // through the 4.6M Slovak court decisions (~25 items/page
  // × ~4s/page) instead of blocking on 5-30s PDF downloads.
  // Decisions are searchable by case number, ECLI, court,
  // and date immediately; fulltext and the AST follow when
  // the walk reaches them. Until it does, the decision has
  // no readable text, so the two must ship together.

  const decisionDate = parseSkDate(item.datumVydania);
  const decisionType = toOptionalValue(item.formaRozhodnutia);
  const ecli = toOptionalValue(detail?.ecli);

  return {
    caseNumber,
    ecli,
    court,
    country: "SVK",
    language: SK_COURTS_LANGUAGE,
    decisionDate,
    decisionType,
    sourceDocumentId: skCourtsSourceDocumentId(item.guid),
    sourceUrl: item.guid
      ? sanitizeUrl(sourceUrlForDecision(item.guid, detail?.dokument?.url))
      : undefined,
    documentUrl:
      restrictSkCourtDocumentUrl(
        toOptionalValue(detail?.dokument?.url) ?? "",
      )?.toString() ?? undefined,
    metadata: {
      caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      guid: toOptionalValue(item.guid),
      identifikacneCislo: toOptionalValue(item.identifikacneCislo),
      judge: toOptionalValue(item.sudca?.meno),
      judgeRegistreGuid: toOptionalValue(item.sudca?.registreGuid),
      courtRegistreGuid: toOptionalValue(item.sud?.registreGuid),
      decisionNature: item.povaha,
      subArea: detail?.podOblast,
      referencedLegislation: detail?.odkazovanePredpisy,
      documentName: toOptionalValue(detail?.dokument?.name),
      documentExtension: toOptionalValue(detail?.dokument?.fileExtension),
      documentSize: detail?.dokument?.size,
      updateDate: toOptionalValue(detail?.updateDate),
    },
    rawHash,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
    documentAst: EMPTY_AST,
    sourceRaw: JSON.stringify({ listItem: item, detail }),
    sourceRawContentType: "application/json",
  };
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
  /** The publisher served no record for the id the listing states. */
  | { type: "detail-unavailable"; decision: IngestionResult };

/**
 * Build one decision from a listing item, through this adapter's own parse and
 * enrichment path. Shared by the crawl and the reconciliation walk so neither
 * can key, parse or enrich an item differently from the other.
 */
export const buildSkCourtsDecision = async (
  item: SkApiItem,
  signal?: AbortSignal,
): Promise<SkCourtsBuildResult> => {
  const fields = skCourtsIdentityFields(item);
  if (fields === null) {
    return { type: "unkeyable" };
  }
  const fetched = await fetchDetailForItem(item, signal);
  const decision = buildDecisionFromParts({
    item,
    fields,
    detail: fetched.type === "detail" ? fetched.detail : null,
  });
  return fetched.type === "unavailable"
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  if (!isSkApiItem(raw)) {
    return null;
  }
  const built = await buildSkCourtsDecision(raw, signal);
  switch (built.type) {
    case "unkeyable":
      return null;
    // The page has to keep moving, and the listing observation is still worth
    // storing; the reconciliation refuses the same row, see `buildDecision`.
    case "detail-unavailable":
    case "built":
      return built.decision;
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
export const SK_COURTS_FIRST_SLICE = "1965-07-11";

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
 * unit selects it again, and the crawl does not reach it either — the
 * newest-first lap orders by decision date and stops after
 * {@link LIVE_WINDOW_ITEMS}, which at this source's volume spans about two
 * months of dates, so an old-dated new record is nowhere near the head it
 * walks. Closing it needs the loop to re-survey settled slices on a slow
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
 * The envelope a slice walk reads.
 *
 * Both fields are required, unlike {@link isSkApiResponse}, whose optionality
 * exists so the crawl can shrug off a page: an envelope that states a count
 * but no list would otherwise read as a date holding nothing, which is the one
 * answer a ledger row must never be written from. The items themselves stay
 * unknown, because the opposite mistake is just as bad — requiring every item
 * to validate would let one malformed row make a date permanently unwalkable —
 * so they are validated one at a time by the identity rule, exactly as the
 * crawl validates them.
 */
type SkSliceResponse = {
  rozhodnutieList: Record<string, unknown>[];
  numFound: number;
};

const isSkSliceResponse = (value: unknown): value is SkSliceResponse =>
  isRecord(value) &&
  isArrayOf(value["rozhodnutieList"], isRecord) &&
  typeof value["numFound"] === "number";

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
const listSkCourtsSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  // Refused here rather than at the publisher: this endpoint ignores a date it
  // cannot parse and answers the whole 4.6M-decision collection instead, which
  // a walk would read as one date holding all of it.
  skCourtsDaySlices.dayStart(slice);
  const url = `${BASE_URL}?${new URLSearchParams({
    page: String(page + LISTING_FIRST_PAGE),
    size: String(LISTING_PAGE_SIZE),
    sortProperty: SLICE_SORT_PROPERTY,
    sortDirection: SLICE_SORT_DIRECTION,
    vydaniaOd: slice,
    vydaniaDo: slice,
  }).toString()}`;

  const response = await fetchWithTimeout(url, {
    signal,
    timeoutMs: LIST_TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      "User-Agent": INGESTION_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `SK courts listing API error: ${response.status}`,
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      cursor: slice,
      httpStatus: response.status,
    });
  }

  const json: unknown = await response.json();
  if (!isSkSliceResponse(json)) {
    throw new AdapterFetchError({
      message:
        "SK courts listing API stated no count and item list for the slice",
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      cursor: slice,
    });
  }

  const { numFound: total, rozhodnutieList: listed } = json;
  // The count and the list have to agree about this page existing. They are
  // read from one response, so an offset the count says is populated answering
  // with nothing is the publisher contradicting itself, not a date running out
  // — and a page dropped here is not merely lost, it is written to the ledger
  // as part of what the date holds.
  if (total > page * LISTING_PAGE_SIZE && listed.length === 0) {
    throw new AdapterFetchError({
      message: `SK courts listing API stated ${total} for ${slice} but listed nothing at page ${page}`,
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      cursor: slice,
    });
  }

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
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isSkApiItem(payload)) {
    return { type: "unkeyable" };
  }
  const built = await buildSkCourtsDecision(payload, signal);
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    // Written as a decision it would make the identity held with the document
    // still unread, and unread is how the document walk finds its work.
    case "detail-unavailable":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(
        `Unhandled sk-courts build result: ${JSON.stringify(built)}`,
      );
    }
  }
};

export const skCourtsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.SK_COURTS,
  name: "obcan.justice.sk",
  country: "SVK",
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
    const response = await fetchWithTimeout(
      `${BASE_URL}?${new URLSearchParams({ page: "0", size: "1" }).toString()}`,
      {
        signal,
        headers: { Accept: "application/json" },
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      },
    );
    if (!response.ok) {
      return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
    }
    const json: unknown = await response.json();
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
    firstSlice: SK_COURTS_FIRST_SLICE,
    ...skCourtsDaySlices.walk,
    tipWindowDays: SK_COURTS_TIP_WINDOW_DAYS,
    listSlicePage: listSkCourtsSlicePage,
    buildDecision: buildSkCourtsFromPayload,
  },

  fetchPage: createPagePaginatedFetch<SkApiResponse>({
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    pageSize: PAGE_SIZE,
    legacyPageSize: LEGACY_PAGE_SIZE,
    firstPage: FIRST_PAGE,
    listTimeoutMs: 60_000,
    itemConcurrency: ITEM_CONCURRENCY,

    buildRequest: (page) => listRequest(page, "DESC"),

    // Oldest-first until the collection has been seen, then newest-first.
    // Walking this source newest-first from the start cannot catch up: it
    // publishes continuously, and each new decision shifts every later
    // offset, so items slide past the cursor unseen. Oldest-first converges
    // because new decisions land at the end, behind the cursor.
    traversal: [
      {
        name: "backfill",
        buildRequest: (page) => listRequest(page, "ASC"),
        followedBy: "live",
      },
      {
        name: "live",
        buildRequest: (page) => listRequest(page, "DESC"),
        followedBy: null,
        // Newest-first only has to reach as far back as what was published
        // since the last cycle. Walking further would drift into history
        // this source has already been caught up on.
        windowItems: LIVE_WINDOW_ITEMS,
      },
    ],

    parseResponse: async (response) => {
      const json: unknown = await response.json();
      return isSkApiResponse(json) ? json : {};
    },

    extractItems: (data) => ({
      items: arrayOrEmpty(data.rozhodnutieList),
      total: toOptionalValue(data.numFound),
    }),

    parseItem: parseItemWithDetail,
  }),
});
