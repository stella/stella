import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
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
import { parseSkDecisionPdf } from "@/api/handlers/case-law/ingestion/parsers/sk-courts";
import { sanitizeUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obcan.justice.sk REST API.
 * Page-based pagination (0-indexed, 25 items per page).
 *
 * Each list item is enriched with a detail fetch for
 * ECLI, document URL, and referenced legislation.
 *
 * Cursor format: page number as string (e.g. "0", "1").
 */

const BASE_URL =
  "https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie";
const PAGE_SIZE = 25;

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
  isNullishString(value.registreGuid) &&
  isNullishString(value.nazov);

const isSkSudca = (value: unknown): value is SkSudca =>
  isRecord(value) &&
  isNullishString(value.registreGuid) &&
  isNullishString(value.meno);

const isSkDokument = (
  value: unknown,
): value is SkDokument & { size?: number } =>
  isRecord(value) &&
  isNullishString(value.name) &&
  isNullishString(value.fileExtension) &&
  isNullishString(value.url) &&
  isOptionalNumber(value.size);

const isSkOdkazovanyPredpis = (value: unknown): value is SkOdkazovanyPredpis =>
  isRecord(value) && isNullishString(value.nazov) && isNullishString(value.url);

const isSkApiItem = (value: unknown): value is SkApiItem =>
  isRecord(value) &&
  isNullishString(value.guid) &&
  isNullishString(value.spisovaZnacka) &&
  isNullishString(value.identifikacneCislo) &&
  isNullishValue(value.sud, isSkSud) &&
  isNullishValue(value.sudca, isSkSudca) &&
  isNullishString(value.datumVydania) &&
  isNullishString(value.formaRozhodnutia) &&
  isOptionalStringArray(value.povaha);

const isSkApiItemRecord = (
  value: unknown,
): value is Record<string, unknown> & SkApiItem =>
  isRecord(value) && isSkApiItem(value);

const isSkDetailItem = (value: unknown): value is SkDetailItem => {
  if (!isSkApiItemRecord(value)) {
    return false;
  }

  return (
    isNullishString(value.ecli) &&
    isOptionalStringArray(value.podOblast) &&
    isNullishArrayOf(value.odkazovanePredpisy, isSkOdkazovanyPredpis) &&
    isNullishValue(value.dokument, isSkDokument) &&
    isNullishString(value.updateDate)
  );
};

const isSkApiResponse = (value: unknown): value is SkApiResponse =>
  isRecord(value) &&
  isNullishArrayOf(value.rozhodnutieList, isSkApiItem) &&
  isOptionalNumber(value.numFound);

/** Parse Slovak date "DD.MM.YYYY" to ISO "YYYY-MM-DD". */
const parseSkDate = (raw: string | null | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const result = parseCeDate(raw);
  if (!result) {
    // eslint-disable-next-line no-console -- adapter diagnostic
    console.warn("SK Courts adapter: unexpected date format", raw);
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
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST)])
      : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    // eslint-disable-next-line no-console -- adapter diagnostic
    console.warn(`SK Courts detail fetch failed: ${response.status}`, guid);
    return null;
  }

  const json: unknown = await response.json();
  if (!isSkDetailItem(json)) {
    return null;
  }
  return json;
};

/**
 * Fetch a PDF from the SK courts document endpoint.
 * Returns raw bytes for @libpdf/core parsing.
 */
const fetchPdfBytes = async (
  documentUrl: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> => {
  try {
    const response = await fetch(documentUrl, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return undefined;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
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

  // Fetch PDF bytes for parsing
  const pdfBytes = detail?.dokument?.url
    ? await fetchPdfBytes(detail.dokument.url, signal)
    : undefined;

  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
  const rawJson = JSON.stringify(item);

  const caseNumber = item.spisovaZnacka;
  const decisionDate = parseSkDate(item.datumVydania);
  const decisionType = toOptionalValue(item.formaRozhodnutia);
  const court = item.sud.nazov;
  const ecli = toOptionalValue(detail?.ecli);

  // Parse PDF into structured AST using @libpdf/core
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- AST container
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
        decisionType: decisionType?.toLowerCase(),
      });
      documentAst = parsed.documentAst;
      fulltext = parsed.fulltext;
    } catch {
      // Parser failed; keep empty AST + no fulltext
    }
  }

  return {
    caseNumber,
    ecli,
    court,
    country: "SVK",
    language: "sk",
    decisionDate,
    decisionType,
    fulltext,
    sourceUrl: item.guid
      ? sanitizeUrl(sourceUrlForDecision(item.guid, detail?.dokument?.url))
      : undefined,
    documentUrl: sanitizeUrl(toOptionalValue(detail?.dokument?.url) ?? ""),
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
    rawHash: hashContent(rawJson),
    parserVersion: PARSER_VERSION,
    documentAst,
    sourceRaw: JSON.stringify({ listItem: item, detail }),
    sourceRawBytes: pdfBytes,
    sourceRawContentType: pdfBytes ? "application/pdf" : "application/json",
  };
};

export const skCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_COURTS,
  name: "obcan.justice.sk",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 300,
  pageTimeoutMs: 120_000,

  fetchPage: createPagePaginatedFetch<SkApiResponse>({
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    pageSize: PAGE_SIZE,
    zeroIndexed: true,
    listTimeoutMs: 60_000,

    buildRequest: (page) => ({
      url: `${BASE_URL}?${new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
        sortProperty: "datumVydania",
        sortDirection: "DESC",
      }).toString()}`,
      init: {
        headers: { Accept: "application/json" },
      },
    }),

    parseResponse: async (response) => {
      const json: unknown = await response.json();
      return isSkApiResponse(json) ? json : {};
    },

    extractItems: (data) => ({
      items: data.rozhodnutieList ?? [],
      total: toOptionalValue(data.numFound),
    }),

    parseItem: parseItemWithDetail,
  }),
};
