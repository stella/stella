import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
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
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Polish Courts adapter (SAOS).
 *
 * Fetches judgments from the SAOS open data API
 * (saos.org.pl). Page-based pagination (0-indexed).
 *
 * Cursor format: page number as string (e.g. "0", "1").
 */

const BASE_URL = "https://www.saos.org.pl/api/search/judgments";
const PAGE_SIZE = 50;

/** Court type hierarchy from SAOS. */
const COURT_TYPE_MAP: Record<string, string> = {
  COMMON: "Common Court",
  SUPREME: "Supreme Court",
  ADMINISTRATIVE: "Administrative Court",
  CONSTITUTIONAL_TRIBUNAL: "Constitutional Tribunal",
  NATIONAL_APPEAL_CHAMBER: "National Appeal Chamber",
};

type SaosJudge = {
  name: string;
  function?: string | null;
  specialRoles?: string[] | null;
};

type SaosCourt = {
  name?: string | null;
  code?: string | null;
  type?: string | null;
};

type SaosDivision = {
  name?: string | null;
  court?: SaosCourt | null;
};

type SaosItem = {
  id?: number | null;
  courtType?: string | null;
  courtCases?: { caseNumber?: string | null }[] | null;
  judgmentType?: string | null;
  judgmentDate?: string | null;
  judges?: SaosJudge[] | null;
  textContent?: string | null;
  keywords?: string[] | null;
  division?: SaosDivision | null;
  source?: {
    sourceUrl?: string | null;
  } | null;
  ecli?: string | null;
};

type SaosResponse = {
  items?: SaosItem[] | null;
  queryTemplate?: {
    pageSize?: { value?: number | null } | null;
    pageNumber?: { value?: number | null } | null;
  } | null;
  info?: {
    totalResults?: number | null;
  } | null;
};

const isOptionalNumber = (value: unknown): value is number | null | undefined =>
  isNullishNumber(value);

const isSaosJudge = (value: unknown): value is SaosJudge =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isNullishString(value.function) &&
  isNullishArrayOf(
    value.specialRoles,
    (item): item is string => typeof item === "string",
  );

const isSaosCourt = (value: unknown): value is SaosCourt =>
  isRecord(value) &&
  isNullishString(value.name) &&
  isNullishString(value.code) &&
  isNullishString(value.type);

const isSaosDivision = (value: unknown): value is SaosDivision =>
  isRecord(value) &&
  isNullishString(value.name) &&
  isNullishValue(value.court, isSaosCourt);

const isSaosCourtCase = (
  value: unknown,
): value is { caseNumber?: string | null | undefined } =>
  isRecord(value) && isNullishString(value.caseNumber);

const isSaosSource = (
  value: unknown,
): value is { sourceUrl?: string | null | undefined } =>
  isRecord(value) && isNullishString(value.sourceUrl);

const isSaosItem = (value: unknown): value is SaosItem =>
  isRecord(value) &&
  isOptionalNumber(value.id) &&
  isNullishString(value.courtType) &&
  isNullishArrayOf(value.courtCases, isSaosCourtCase) &&
  isNullishString(value.judgmentType) &&
  isNullishString(value.judgmentDate) &&
  isNullishArrayOf(value.judges, isSaosJudge) &&
  isNullishString(value.textContent) &&
  isNullishArrayOf(
    value.keywords,
    (item): item is string => typeof item === "string",
  ) &&
  isNullishValue(value.division, isSaosDivision) &&
  isNullishValue(value.source, isSaosSource) &&
  isNullishString(value.ecli);

const isPageValue = (value: unknown): value is { value?: number | undefined } =>
  isRecord(value) && isOptionalNumber(value.value);

const isSaosResponse = (value: unknown): value is SaosResponse =>
  isRecord(value) &&
  isNullishArrayOf(value.items, isSaosItem) &&
  isNullishValue(
    value.queryTemplate,
    (
      queryTemplate,
    ): queryTemplate is NonNullable<SaosResponse["queryTemplate"]> =>
      isRecord(queryTemplate) &&
      isNullishValue(queryTemplate.pageSize, isPageValue) &&
      isNullishValue(queryTemplate.pageNumber, isPageValue),
  ) &&
  isNullishValue(
    value.info,
    (info): info is NonNullable<SaosResponse["info"]> =>
      isRecord(info) && isOptionalNumber(info.totalResults),
  );

const parseItem = (item: SaosItem): IngestionResult | null => {
  const primaryCase = item.courtCases?.find((c) => c.caseNumber);
  const caseNumber = toOptionalValue(primaryCase?.caseNumber);
  const courtName =
    item.division?.court?.name ??
    (item.courtType
      ? (COURT_TYPE_MAP[item.courtType] ?? item.courtType)
      : undefined);

  if (!caseNumber || !courtName) {
    return null;
  }

  const additionalCaseNumbers = item.courtCases
    ?.filter(
      (c): c is { caseNumber: string } =>
        Boolean(c.caseNumber) && c.caseNumber !== caseNumber,
    )
    .map((c) => c.caseNumber);

  const raw = JSON.stringify(item);

  return {
    caseNumber,
    ecli: toOptionalValue(item.ecli),
    court: courtName,
    country: "POL",
    language: "pl",
    decisionDate: toOptionalValue(item.judgmentDate),
    decisionType: toOptionalValue(item.judgmentType),
    fulltext: toOptionalValue(item.textContent),
    sourceUrl: toOptionalValue(item.source?.sourceUrl),
    metadata: {
      saosId: item.id,
      courtType: toOptionalValue(item.courtType),
      courtCode: toOptionalValue(item.division?.court?.code),
      judges: item.judges?.map((j) => ({
        name: j.name,
        function: toOptionalValue(j.function),
        specialRoles: j.specialRoles,
      })),
      keywords: item.keywords,
      division: toOptionalValue(item.division?.name),
      ...((additionalCaseNumbers?.length ?? 0) > 0 && {
        additionalCaseNumbers,
      }),
    },
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSION,
    // TODO: integrate court-specific parser for AST
    documentAst: EMPTY_AST,
    sourceRaw: undefined,
    sourceRawContentType: "application/json",
  };
};

export const plCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.PL_COURTS,
  name: "Polish Courts (SAOS)",
  country: "POL",
  language: "pl",
  minRequestIntervalMs: 200,

  fetchPage: createPagePaginatedFetch<SaosResponse>({
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    pageSize: PAGE_SIZE,
    zeroIndexed: true,

    buildRequest: (page) => ({
      url: `${BASE_URL}?${new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        pageNumber: String(page),
        sortingField: "JUDGMENT_DATE",
        sortingDirection: "DESC",
      }).toString()}`,
      init: {
        headers: { Accept: "application/json" },
      },
    }),

    parseResponse: async (response) => {
      const json: unknown = await response.json();
      return isSaosResponse(json) ? json : {};
    },

    extractItems: (data) => ({
      items: data.items ?? [],
      total: toOptionalValue(data.info?.totalResults),
    }),

    parseItem: async (raw) =>
      await Promise.resolve(isSaosItem(raw) ? parseItem(raw) : null),
  }),
};
