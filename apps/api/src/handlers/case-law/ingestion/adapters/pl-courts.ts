import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import { hashContent } from "@/api/handlers/case-law/ingestion/adapters/utils";

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
  function?: string;
  specialRoles?: string[];
};

type SaosCourt = {
  name?: string;
  code?: string;
  type?: string;
};

type SaosDivision = {
  name?: string;
  court?: SaosCourt;
};

type SaosItem = {
  id?: number;
  courtType?: string;
  courtCases?: { caseNumber?: string }[];
  judgmentType?: string;
  judgmentDate?: string;
  judges?: SaosJudge[];
  textContent?: string;
  keywords?: string[];
  division?: SaosDivision;
  source?: {
    sourceUrl?: string;
  };
  ecli?: string;
};

type SaosResponse = {
  items?: SaosItem[];
  queryTemplate?: {
    pageSize?: { value?: number };
    pageNumber?: { value?: number };
  };
  info?: {
    totalResults?: number;
  };
};

const parseItem = (item: SaosItem): IngestionResult | null => {
  const primaryCase = item.courtCases?.find((c) => c.caseNumber);
  const caseNumber = primaryCase?.caseNumber;
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
    ecli: item.ecli,
    court: courtName,
    country: "POL",
    language: "pl",
    decisionDate: item.judgmentDate,
    decisionType: item.judgmentType,
    fulltext: item.textContent,
    sourceUrl: item.source?.sourceUrl,
    metadata: {
      saosId: item.id,
      courtType: item.courtType,
      courtCode: item.division?.court?.code,
      judges: item.judges?.map((j) => ({
        name: j.name,
        function: j.function,
        specialRoles: j.specialRoles,
      })),
      keywords: item.keywords,
      division: item.division?.name,
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
      // SAFETY: structural check confirms object; all
      // fields are optional so missing properties
      // degrade gracefully.
      return typeof json === "object" && json !== null
        ? (json as SaosResponse) // eslint-disable-line typescript-eslint/no-unsafe-type-assertion, typescript/consistent-type-assertions
        : {};
    },

    extractItems: (data) => ({
      items: data.items ?? [],
      total: data.info?.totalResults,
    }),

    // SAFETY: items come from extractItems which returns
    // data.items (SaosItem[]); all fields are optional.
    parseItem: async (raw) => await Promise.resolve(parseItem(raw as SaosItem)), // eslint-disable-line typescript-eslint/no-unsafe-type-assertion, typescript/consistent-type-assertions
  }),
};
