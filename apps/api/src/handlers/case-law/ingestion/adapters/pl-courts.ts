import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  hashContent,
  INGESTION_USER_AGENT,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  stripHtml,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Polish Courts adapter (SAOS).
 *
 * Uses the SAOS dump endpoint for complete historical crawling,
 * then enriches each decision through the per-judgment detail
 * endpoint. The detail record is materially richer than the
 * search list: it exposes structured HTML, cited regulations,
 * referenced cases, reporters, publication metadata, and the
 * original court document URL.
 *
 * Cursor format: page number as string (e.g. "0", "1").
 */

const DUMP_URL = "https://www.saos.org.pl/api/dump/judgments";
const SEARCH_URL = "https://www.saos.org.pl/api/search/judgments";
const DETAIL_URL = "https://www.saos.org.pl/api/judgments";
const PUBLIC_JUDGMENT_URL = "https://www.saos.org.pl/judgments";
const PAGE_SIZE = 20;

const COURT_TYPE_MAP: Record<string, string> = {
  COMMON: "Sąd powszechny",
  SUPREME: "Sąd Najwyższy",
  ADMINISTRATIVE: "Sąd administracyjny",
  CONSTITUTIONAL_TRIBUNAL: "Trybunał Konstytucyjny",
  NATIONAL_APPEAL_CHAMBER: "Krajowa Izba Odwoławcza",
};

const JUDGMENT_TYPE_MAP: Record<string, string> = {
  SENTENCE: "wyrok",
  DECISION: "postanowienie",
  RESOLUTION: "uchwała",
  REASONS: "uzasadnienie",
  REGULATION: "zarządzenie",
};

const POLISH_MONTHS: Record<string, string> = {
  stycznia: "01",
  lutego: "02",
  marca: "03",
  kwietnia: "04",
  maja: "05",
  czerwca: "06",
  lipca: "07",
  sierpnia: "08",
  września: "09",
  października: "10",
  listopada: "11",
  grudnia: "12",
};

const POLISH_DATE_RE =
  /(?:^|[\s,])(?:z dnia\s+)?(\d{1,2})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia)\s+(\d{4})\s*r?(?:oku)?\.?/iu;

type SaosJudge = {
  name: string;
  function?: string | null;
  specialRoles?: string[] | null;
};

type SaosCourtCase = {
  caseNumber?: string | null;
};

type SaosCourt = {
  href?: string | null;
  id?: number | null;
  code?: string | null;
  name?: string | null;
  type?: string | null;
};

type SaosDivision = {
  href?: string | null;
  id?: number | null;
  name?: string | null;
  code?: string | null;
  type?: string | null;
  court?: SaosCourt | null;
};

type SaosSource = {
  code?: string | null;
  judgmentUrl?: string | null;
  judgmentId?: string | null;
  publisher?: string | null;
  reviser?: string | null;
  publicationDate?: string | null;
};

type SaosReferencedRegulation = {
  journalTitle?: string | null;
  journalNo?: number | null;
  journalYear?: number | null;
  journalEntry?: number | null;
  text?: string | null;
};

type SaosReferencedCourtCase = {
  caseNumber?: string | null;
  judgmentIds?: number[] | null;
  generated?: boolean | null;
};

type SaosItem = {
  id?: number | null;
  href?: string | null;
  courtType?: string | null;
  courtCases?: SaosCourtCase[] | null;
  judgmentType?: string | null;
  judgmentDate?: string | null;
  judges?: SaosJudge[] | null;
  textContent?: string | null;
  keywords?: string[] | null;
  division?: SaosDivision | null;
  source?: SaosSource | null;
  ecli?: string | null;
  courtReporters?: string[] | null;
  decision?: string | null;
  summary?: string | null;
  legalBases?: string[] | null;
  referencedRegulations?: SaosReferencedRegulation[] | null;
  referencedCourtCases?: SaosReferencedCourtCase[] | null;
  receiptDate?: string | null;
  meansOfAppeal?: string | null;
  judgmentResult?: string | null;
  lowerCourtJudgments?: SaosCourtCase[] | null;
  dissentingOpinions?: unknown[] | null;
};

type SaosDumpResponse = {
  items?: SaosItem[] | null;
  queryTemplate?: {
    pageNumber?: { value?: number | null } | null;
    pageSize?: { value?: number | null } | null;
  } | null;
};

type SaosSearchResponse = {
  info?: {
    totalResults?: number | null;
  } | null;
};

type SaosDetailResponse = {
  data?: SaosItem | null;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOptionalStringArray = (
  value: unknown,
): value is string[] | null | undefined =>
  value === undefined || value === null || isStringArray(value);

const isSaosJudge = (value: unknown): value is SaosJudge =>
  isRecord(value) &&
  typeof value["name"] === "string" &&
  isNullishString(value["function"]) &&
  isNullishArrayOf(
    value["specialRoles"],
    (item): item is string => typeof item === "string",
  );

const isSaosCourtCase = (value: unknown): value is SaosCourtCase =>
  isRecord(value) && isNullishString(value["caseNumber"]);

const isSaosCourt = (value: unknown): value is SaosCourt =>
  isRecord(value) &&
  isNullishNumber(value["id"]) &&
  isNullishString(value["href"]) &&
  isNullishString(value["code"]) &&
  isNullishString(value["name"]) &&
  isNullishString(value["type"]);

const isSaosDivision = (value: unknown): value is SaosDivision =>
  isRecord(value) &&
  isNullishNumber(value["id"]) &&
  isNullishString(value["href"]) &&
  isNullishString(value["name"]) &&
  isNullishString(value["code"]) &&
  isNullishString(value["type"]) &&
  isNullishValue(value["court"], isSaosCourt);

const isSaosSource = (value: unknown): value is SaosSource =>
  isRecord(value) &&
  isNullishString(value["code"]) &&
  isNullishString(value["judgmentUrl"]) &&
  isNullishString(value["judgmentId"]) &&
  isNullishString(value["publisher"]) &&
  isNullishString(value["reviser"]) &&
  isNullishString(value["publicationDate"]);

const isSaosReferencedRegulation = (
  value: unknown,
): value is SaosReferencedRegulation =>
  isRecord(value) &&
  isNullishString(value["journalTitle"]) &&
  isNullishNumber(value["journalNo"]) &&
  isNullishNumber(value["journalYear"]) &&
  isNullishNumber(value["journalEntry"]) &&
  isNullishString(value["text"]);

const isSaosReferencedCourtCase = (
  value: unknown,
): value is SaosReferencedCourtCase =>
  isRecord(value) &&
  isNullishString(value["caseNumber"]) &&
  isNullishArrayOf(
    value["judgmentIds"],
    (item): item is number => typeof item === "number",
  ) &&
  (value["generated"] === undefined ||
    value["generated"] === null ||
    typeof value["generated"] === "boolean");

const isSaosItem = (value: unknown): value is SaosItem =>
  isRecord(value) &&
  isNullishNumber(value["id"]) &&
  isNullishString(value["href"]) &&
  isNullishString(value["courtType"]) &&
  isNullishArrayOf(value["courtCases"], isSaosCourtCase) &&
  isNullishString(value["judgmentType"]) &&
  isNullishString(value["judgmentDate"]) &&
  isNullishArrayOf(value["judges"], isSaosJudge) &&
  isNullishString(value["textContent"]) &&
  isOptionalStringArray(value["keywords"]) &&
  isNullishValue(value["division"], isSaosDivision) &&
  isNullishValue(value["source"], isSaosSource) &&
  isNullishString(value["ecli"]) &&
  isOptionalStringArray(value["courtReporters"]) &&
  isNullishString(value["decision"]) &&
  isNullishString(value["summary"]) &&
  isOptionalStringArray(value["legalBases"]) &&
  isNullishArrayOf(
    value["referencedRegulations"],
    isSaosReferencedRegulation,
  ) &&
  isNullishArrayOf(value["referencedCourtCases"], isSaosReferencedCourtCase) &&
  isNullishString(value["receiptDate"]) &&
  isNullishString(value["meansOfAppeal"]) &&
  isNullishString(value["judgmentResult"]) &&
  isNullishArrayOf(value["lowerCourtJudgments"], isSaosCourtCase) &&
  (value["dissentingOpinions"] === undefined ||
    value["dissentingOpinions"] === null ||
    Array.isArray(value["dissentingOpinions"]));

const isSaosDumpResponse = (value: unknown): value is SaosDumpResponse =>
  isRecord(value) && isNullishArrayOf(value["items"], isRecord);

const isSaosSearchResponse = (value: unknown): value is SaosSearchResponse =>
  isRecord(value) &&
  isNullishValue(
    value["info"],
    (info): info is NonNullable<SaosSearchResponse["info"]> =>
      isRecord(info) && isNullishNumber(info["totalResults"]),
  );

const isSaosDetailResponse = (value: unknown): value is SaosDetailResponse =>
  isRecord(value) && isNullishValue(value["data"], isSaosItem);

const normalizeDecisionType = (
  raw: string | null | undefined,
  content: string | null | undefined,
): string | undefined => {
  if (raw) {
    const mapped = JUDGMENT_TYPE_MAP[raw];
    if (mapped) {
      return mapped;
    }
    return raw.toLocaleLowerCase("pl-PL");
  }

  if (!content) {
    return undefined;
  }

  const text = stripHtml(content);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 6)) {
    const lowered = line.toLocaleLowerCase("pl-PL");
    if (
      lowered === "wyrok" ||
      lowered === "postanowienie" ||
      lowered === "uchwała" ||
      lowered === "uzasadnienie" ||
      lowered === "zarządzenie"
    ) {
      return lowered;
    }
  }

  return undefined;
};

const parseDecisionDateFromContent = (
  content: string | null | undefined,
): string | undefined => {
  if (!content) {
    return undefined;
  }

  const text = stripHtml(content);
  const match = POLISH_DATE_RE.exec(text);
  const day = match?.[1]?.padStart(2, "0");
  const monthName = match?.[2]?.toLocaleLowerCase("pl-PL");
  const year = match?.[3];

  if (!day || !monthName || !year) {
    return undefined;
  }

  const month = POLISH_MONTHS[monthName];
  if (!month) {
    return undefined;
  }

  return `${year}-${month}-${day}`;
};

const normalizeDecisionDate = (
  raw: string | null | undefined,
  content: string | null | undefined,
): string | undefined => {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const year = Number.parseInt(raw.slice(0, 4), 10);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) {
      return raw;
    }
  }

  return parseDecisionDateFromContent(content) ?? toOptionalValue(raw);
};

const fetchDetail = async (
  id: number,
  signal?: AbortSignal,
): Promise<SaosItem | null> => {
  let response: Response;
  try {
    response = await fetch(`${DETAIL_URL}/${id}`, {
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
          ])
        : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
      headers: {
        Accept: "application/json",
        "User-Agent": INGESTION_USER_AGENT,
      },
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }
  if (!isSaosDetailResponse(json)) {
    return null;
  }

  return json.data ?? null;
};

const publicSourceUrl = (id: number | null | undefined): string | undefined =>
  id !== undefined && id !== null ? `${PUBLIC_JUDGMENT_URL}/${id}` : undefined;

/**
 * SAOS dissentingOpinions can be plain strings OR objects
 * with a `textContent` field. Normalize to string[].
 * Unknown shapes are dropped (stored verbatim in sourceRaw).
 */
const normalizeDissentingOpinions = (
  opinions: unknown[] | null | undefined,
): string[] => {
  if (!opinions) {
    return [];
  }
  const result: string[] = [];
  for (const opinion of opinions) {
    if (typeof opinion === "string") {
      result.push(opinion);
    } else if (
      isRecord(opinion) &&
      typeof opinion["textContent"] === "string"
    ) {
      result.push(opinion["textContent"]);
    }
    // Other shapes dropped; raw data preserved in sourceRaw for re-parsing.
  }
  return result;
};

const courtNameForItem = (item: SaosItem): string | undefined =>
  toOptionalValue(
    item.division?.court?.name ??
      (item.courtType
        ? (COURT_TYPE_MAP[item.courtType] ?? item.courtType)
        : undefined),
  );

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  if (!isRecord(raw)) {
    return null;
  }

  // SAFETY: All SaosItem fields are optional/nullable. The function
  // accesses them with optional chaining and null checks throughout.
  // Full isSaosItem validation was moved out of the hot path because
  // a single unexpected field type (e.g. dissentingOpinions as object)
  // would reject the entire page, blocking all ingestion.
  const dumpItem = raw as SaosItem;
  const detail =
    dumpItem.id !== undefined && dumpItem.id !== null
      ? await fetchDetail(dumpItem.id, signal)
      : null;
  const item = detail ?? dumpItem;

  const primaryCase =
    item.courtCases?.find((courtCase) => courtCase.caseNumber) ??
    dumpItem.courtCases?.find((courtCase) => courtCase.caseNumber);
  const caseNumber = toOptionalValue(primaryCase?.caseNumber);
  const courtName =
    toOptionalValue(item.division?.court?.name) ??
    courtNameForItem(dumpItem) ??
    courtNameForItem(item);

  if (!caseNumber || !courtName) {
    return null;
  }

  const content = item.textContent ?? dumpItem.textContent;
  const decisionType = normalizeDecisionType(
    item.judgmentType ?? dumpItem.judgmentType,
    content,
  );
  const decisionDate = normalizeDecisionDate(
    item.judgmentDate ?? dumpItem.judgmentDate,
    content,
  );
  const keywords = item.keywords ?? dumpItem.keywords ?? [];
  const statutes = item.legalBases ?? dumpItem.legalBases ?? [];
  const ecli = toOptionalValue(item.ecli ?? dumpItem.ecli);
  const documentUrl = toOptionalValue(
    item.source?.judgmentUrl ?? dumpItem.source?.judgmentUrl,
  );
  const effectiveCourtCases = item.courtCases ?? dumpItem.courtCases;
  const effectiveJudges = item.judges ?? dumpItem.judges;
  const effectiveDivision = item.division ?? dumpItem.division;
  const effectiveSource = item.source ?? dumpItem.source;

  let documentAst: EmptyAst | IngestionResult["documentAst"] = EMPTY_AST;
  let fulltext = toOptionalValue(content ? stripHtml(content) : undefined);

  if (content) {
    try {
      const parserResult = parsePlDecisionContent({
        caseNumber,
        ecli,
        court: courtName,
        decisionDate,
        decisionType,
        sourceUrl: publicSourceUrl(item.id ?? dumpItem.id),
        documentUrl,
        content,
        keywords,
        statutes,
        documentId:
          toOptionalValue(
            item.source?.judgmentId ?? dumpItem.source?.judgmentId,
          ) ?? String(item.id ?? dumpItem.id ?? caseNumber),
      });

      documentAst = parserResult.documentAst;
      fulltext = parserResult.fulltext;
    } catch {
      // Parser failure must not block ingestion.
    }
  }

  const additionalCaseNumbers = effectiveCourtCases
    ?.filter(
      (courtCase): courtCase is { caseNumber: string } =>
        Boolean(courtCase.caseNumber) && courtCase.caseNumber !== caseNumber,
    )
    .map((courtCase) => courtCase.caseNumber);

  const rawPayload = JSON.stringify({ dumpItem, detail });
  const rawHash = hashContent(JSON.stringify(dumpItem));

  return {
    caseNumber,
    ecli,
    court: courtName,
    country: "POL",
    language: "pl",
    decisionDate,
    decisionType,
    fulltext,
    sourceUrl: publicSourceUrl(item.id ?? dumpItem.id),
    documentUrl,
    metadata: {
      caseNumber,
      court: courtName,
      decisionDate,
      decisionType,
      ecli,
      saosId: item.id ?? dumpItem.id,
      href: toOptionalValue(item.href ?? dumpItem.href),
      courtType: toOptionalValue(item.courtType ?? dumpItem.courtType),
      courtCases: effectiveCourtCases,
      judges: effectiveJudges?.map((judge) => ({
        name: judge.name,
        function: toOptionalValue(judge.function),
        specialRoles: judge.specialRoles ?? [],
      })),
      keywords,
      division: effectiveDivision,
      source: effectiveSource,
      courtReporters: item.courtReporters ?? dumpItem.courtReporters ?? [],
      decision: toOptionalValue(item.decision ?? dumpItem.decision),
      summary: toOptionalValue(item.summary ?? dumpItem.summary),
      legalBases: statutes,
      referencedRegulations:
        item.referencedRegulations ?? dumpItem.referencedRegulations ?? [],
      referencedCourtCases:
        item.referencedCourtCases ?? dumpItem.referencedCourtCases ?? [],
      receiptDate: toOptionalValue(item.receiptDate ?? dumpItem.receiptDate),
      meansOfAppeal: toOptionalValue(
        item.meansOfAppeal ?? dumpItem.meansOfAppeal,
      ),
      judgmentResult: toOptionalValue(
        item.judgmentResult ?? dumpItem.judgmentResult,
      ),
      lowerCourtJudgments:
        item.lowerCourtJudgments ?? dumpItem.lowerCourtJudgments ?? [],
      dissentingOpinions: normalizeDissentingOpinions(
        item.dissentingOpinions ?? dumpItem.dissentingOpinions ?? [],
      ),
      ingestion: {
        dumpHash: rawHash,
        sourceTier: detail ? "detail" : "dump",
      },
      ...((additionalCaseNumbers?.length ?? 0) > 0 && {
        additionalCaseNumbers,
      }),
    },
    rawHash,
    parserVersion: PARSER_VERSION,
    documentAst,
    sourceRaw: rawPayload,
    sourceRawContentType: "application/json",
  };
};

export const plCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.PL_COURTS,
  name: "Polish Courts (SAOS)",
  country: "POL",
  language: "pl",
  minRequestIntervalMs: 200,
  pageTimeoutMs: 280_000,
  maxSyncPages: 20,

  async getTotalCount(signal) {
    try {
      const response = await fetch(
        `${SEARCH_URL}?${new URLSearchParams({
          pageSize: "1",
          pageNumber: "0",
          sortingField: "JUDGMENT_DATE",
          sortingDirection: "DESC",
        }).toString()}`,
        {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(ADAPTER_TIMEOUT.LIST),
          ]),
          headers: {
            Accept: "application/json",
            "User-Agent": INGESTION_USER_AGENT,
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const json: unknown = await response.json();
      if (!isSaosSearchResponse(json)) {
        return null;
      }

      return toOptionalValue(json.info?.totalResults) ?? null;
    } catch {
      return null;
    }
  },

  fetchPage: createPagePaginatedFetch<SaosDumpResponse>({
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    pageSize: PAGE_SIZE,
    zeroIndexed: true,
    listTimeoutMs: 60_000,

    buildRequest: (page) => ({
      url: `${DUMP_URL}?${new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        pageNumber: String(page),
        withGenerated: "true",
      }).toString()}`,
      init: {
        headers: { Accept: "application/json" },
      },
    }),

    parseResponse: async (response) => {
      const json: unknown = await response.json();
      return isSaosDumpResponse(json) ? json : {};
    },

    extractItems: (data) => ({
      items: data.items ?? [],
    }),

    parseItem: parseItemWithDetail,
  }),
};
