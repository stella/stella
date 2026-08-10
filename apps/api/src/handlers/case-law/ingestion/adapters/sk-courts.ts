import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import {
  defineSourceAdapter,
  EMPTY_AST,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  hashContent,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  parseCeDate,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import { logger } from "@/api/lib/observability/logger";
import { sanitizeUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obcan.justice.sk REST API.
 * Page-based pagination (0-indexed).
 *
 * Each list item is enriched with a detail fetch for
 * ECLI, document URL, and referenced legislation.
 *
 * Cursor format: item offset as string (e.g. "offset:100").
 */

const BASE_URL =
  "https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie";
const PAGE_SIZE = 100;
const LEGACY_PAGE_SIZE = 100;
const ITEM_CONCURRENCY = 10;
/**
 * How far back the newest-first walk reaches before returning to the head.
 * Comfortably more than this source publishes between cycles, so a slow or
 * skipped cycle still cannot let a decision slip past unseen; already-stored
 * decisions in the overlap cost a list read and are then deduplicated.
 */
const LIVE_WINDOW_ITEMS = 5000;

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

type SkApiItem = {
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

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  if (!isSkApiItem(raw)) {
    return null;
  }
  const item = raw;

  if (!item.spisovaZnacka || !item.sud?.nazov) {
    return null;
  }

  const detail = item.guid ? await fetchDetail(item.guid, signal) : null;

  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
  const rawJson = JSON.stringify(item);
  const rawHash = hashContent(rawJson);

  // PDF download is deferred to the `caseLaw.backfillSkDocuments`
  // scheduler task (ingestion/sk-document-backfill.ts).
  // Metadata-only ingestion (list + detail) lets us fly
  // through the 4.6M Slovak court decisions (~25 items/page
  // × ~4s/page) instead of blocking on 5-30s PDF downloads.
  // Decisions are searchable by case number, ECLI, court,
  // and date immediately; fulltext and the AST follow when
  // that task reaches them. Until it does, the decision has
  // no readable text, so the two must ship together.

  const caseNumber = item.spisovaZnacka;
  const courtInfo = Reflect.get(item, "sud");
  if (!caseNumber || !isSkSud(courtInfo) || !courtInfo.nazov) {
    return null;
  }
  const decisionDate = parseSkDate(item.datumVydania);
  const decisionType = toOptionalValue(item.formaRozhodnutia);
  const court = courtInfo.nazov;
  const ecli = toOptionalValue(detail?.ecli);

  return {
    caseNumber,
    ecli,
    court,
    country: "SVK",
    language: "sk",
    decisionDate,
    decisionType,
    sourceDocumentId: toOptionalValue(item.guid),
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
      courtRegistreGuid: toOptionalValue(courtInfo.registreGuid),
      decisionNature: item.povaha,
      subArea: detail?.podOblast,
      referencedLegislation: detail?.odkazovanePredpisy,
      documentName: toOptionalValue(detail?.dokument?.name),
      documentExtension: toOptionalValue(detail?.dokument?.fileExtension),
      documentSize: detail?.dokument?.size,
      updateDate: toOptionalValue(detail?.updateDate),
    },
    rawHash,
    parserVersion: PARSER_VERSION,
    documentAst: EMPTY_AST,
    sourceRaw: JSON.stringify({ listItem: item, detail }),
    sourceRawContentType: "application/json",
  };
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
      return null;
    }
    const json: unknown = await response.json();
    if (!isRecord(json)) {
      return null;
    }
    const total = json["numFound"];
    return typeof total === "number" && total > 0 ? total : null;
  },

  fetchPage: createPagePaginatedFetch<SkApiResponse>({
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    pageSize: PAGE_SIZE,
    legacyPageSize: LEGACY_PAGE_SIZE,
    zeroIndexed: true,
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
