import { panic, Result } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";
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
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import { fetchPublisher } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  isArrayOf,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  parseCeDate,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { DOCUMENT_DELIVERY } from "@/api/lib/legal-search/ingestion-types";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import type { SkDocumentFetch } from "@/api/lib/legal-search/sk-document-backfill";
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
export const skCourtsDocumentFetch: SkDocumentFetch = async (url, { signal }) =>
  await fetchPublisher(url, {
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    redirect: "error",
    signal,
    timeoutMs: DOCUMENT_TIMEOUT_MS,
  });

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
  isOptionalNumber(value["id"]) &&
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
  const response = await fetchPublisher(url, {
    adapterKey: ADAPTER_KEYS.SK_COURTS,
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
  /** The per-decision record, where one was read. */
  detail: SkDetailItem | null;
};

/**
 * Both responses this source serves for a decision, each kept verbatim under
 * the name the envelope gives it.
 *
 * The detail part is absent rather than null where no record was read: a part
 * that is there states a response, and one that is not states that none was.
 */
const skCourtsSourceRaw = (
  item: SkApiItem,
  detail: SkDetailItem | null,
): { sourceRaw: string; sourceRawContentType: string } => ({
  sourceRaw: encodeSourceRawEnvelope({
    listing: JSON.stringify(item),
    ...(detail === null ? {} : { detail: JSON.stringify(detail) }),
  }),
  sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
});

/**
 * Build one decision from the two responses already in hand, without
 * contacting the publisher, or `null` for an item nothing can key.
 *
 * The seam the crawl, the stored-payload re-parse and the conformance
 * fixtures all go through: a decision keyed or projected one way here is
 * keyed and projected that way everywhere.
 */
export const assembleSkCourtsDecision = ({
  detail,
  item,
}: SkCourtsDecisionParts): IngestionResult | null => {
  const fields = skCourtsIdentityFields(item);
  if (fields === null) {
    return null;
  }
  const { caseNumber, court } = fields;

  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
  const rawJson = JSON.stringify(item);
  const rawHash = hashContent(rawJson);

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
  const decisionType = toOptionalValue(item.formaRozhodnutia);
  const ecli = toOptionalValue(detail?.ecli);

  return {
    caseNumber,
    ecli,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_COURTS].country,
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
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: {
      caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      guid: toOptionalValue(item.guid),
      identifikacneCislo: toOptionalValue(item.identifikacneCislo),
      // The name this service states for a decision is the judge's or a
      // senior court officer's, and the record carries no discriminator, so
      // it stays a stated name rather than becoming a bench role. See the
      // `judge-registry` surface for what would tell the two apart.
      judge: toOptionalValue(item.sudca?.meno),
      judgeRegistreGuid: toOptionalValue(item.sudca?.registreGuid),
      courtRegistreGuid: toOptionalValue(item.sud?.registreGuid),
      decisionNature: item.povaha,
      area: detail?.oblast,
      subArea: detail?.podOblast,
      referencedLegislation: detail?.odkazovanePredpisy,
      documentName: toOptionalValue(detail?.dokument?.name),
      documentExtension: toOptionalValue(detail?.dokument?.fileExtension),
      documentSize: detail?.dokument?.size,
      documentFileId: detail?.dokument?.id,
      updateDate: toOptionalValue(detail?.updateDate),
      originCourt: toOptionalValue(detail?.povodnySud?.nazov),
      originCourtRegistreGuid: toOptionalValue(
        detail?.povodnySud?.registreGuid,
      ),
      originCaseNumber: toOptionalValue(detail?.povodnaSpisovaZnacka),
    },
    rawHash,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
    documentAst: EMPTY_AST,
    documentDelivery: DOCUMENT_DELIVERY.DEFERRED,
    ...skCourtsSourceRaw(item, detail),
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
  // Asked before the record is fetched, so an item nothing can store never
  // costs a request; the assembler answers the same question again over what
  // it was handed.
  if (skCourtsIdentityFields(item) === null) {
    return { type: "unkeyable" };
  }
  const fetched = await fetchDetailForItem(item, signal);
  const decision = assembleSkCourtsDecision({
    item,
    detail: fetched.type === "detail" ? fetched.detail : null,
  });
  if (decision === null) {
    return { type: "unkeyable" };
  }
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
type ListDayPageOptions = {
  day: string;
  page: number;
  pageSize: number;
  signal?: AbortSignal | undefined;
};

/** What one page of a day's listing states: its rows, and the day's size. */
type ListedDayPage = {
  listed: Record<string, unknown>[];
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

  const response = await fetchPublisher(url, {
    adapterKey: ADAPTER_KEYS.SK_COURTS,
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
      cursor: day,
      httpStatus: response.status,
    });
  }

  const json: unknown = await response.json();
  if (!isSkSliceResponse(json)) {
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
): Promise<SyncPage> => {
  const day = nextClosedDay(frontier.verifiedThrough);
  if (day === null) {
    return {
      decisions: [],
      nextCursor: encodeFrontierCursor({
        verifiedThrough: frontier.verifiedThrough,
        page: 0,
      }),
    };
  }

  const { listed, total } = await listSkCourtsDayPage({
    day,
    page: frontier.page,
    pageSize: PAGE_SIZE,
    signal,
  });
  const built = await mapWithConcurrency({
    items: listed,
    limit: ITEM_CONCURRENCY,
    operation: async (item) => await parseItemWithDetail(item, signal),
  });
  const decisions = built.filter(
    (decision): decision is IngestionResult => decision !== null,
  );

  const nextPage = frontier.page + 1;
  return {
    decisions,
    nextCursor:
      nextPage * PAGE_SIZE < total
        ? encodeFrontierCursor({
            verifiedThrough: frontier.verifiedThrough,
            page: nextPage,
          })
        : encodeFrontierCursor({ verifiedThrough: day, page: 0 }),
  };
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

  const decision = assembleSkCourtsDecision({
    item,
    detail: storedPart(parts?.["detail"], isSkDetailItem),
  });
  if (decision === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `the stored listing row for ${stored.caseNumber} states no docket and court to key on`,
    };
  }
  if (decision.caseNumber !== stored.caseNumber) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored payload states ${decision.caseNumber}`,
    };
  }
  return { type: "parsed", result: decision };
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
    "court-registry": excludedSourceSurface(
      "the detail record already embeds the court entry this would state",
    ),
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
  key: ADAPTER_KEYS.SK_COURTS,
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
    const response = await fetchPublisher(
      `${BASE_URL}?${new URLSearchParams({ page: "0", size: "1" }).toString()}`,
      {
        adapterKey: ADAPTER_KEYS.SK_COURTS,
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

  fetchPage: async (cursor, config, signal) => {
    const frontier = decodeFrontierCursor(cursor);
    if (frontier === null) {
      const page = await backfillPage(cursor, config, signal);
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
    return await Result.tryPromise({
      try: async () => await collectFrontierPage(frontier, signal),
      catch: adapterCatch(ADAPTER_KEYS.SK_COURTS, cursor),
    });
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
const backfillPage = createPagePaginatedFetch<SkApiResponse>({
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
    const json: unknown = await response.json();
    return Result.ok(isSkApiResponse(json) ? json : {});
  },

  extractItems: (data) => ({
    items: arrayOrEmpty(data.rozhodnutieList),
    total: toOptionalValue(data.numFound),
  }),

  parseItem: async (item, signal) => {
    const decision = await parseItemWithDetail(item, signal);
    return decision === null ? null : { type: "decision", decision };
  },
});
