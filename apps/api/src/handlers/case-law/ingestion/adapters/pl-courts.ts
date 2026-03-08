import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";

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

const hashResult = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

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
  courtCases?: Array<{ caseNumber?: string }>;
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
      judges: item.judges?.map((j) => j.name),
      keywords: item.keywords,
      division: item.division?.name,
      ...(additionalCaseNumbers?.length && {
        additionalCaseNumbers,
      }),
    },
    rawHash: hashResult(raw),
  };
};

export const plCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.PL_COURTS,
  name: "Polish Courts (SAOS)",
  country: "POL",
  language: "pl",
  minRequestIntervalMs: 1000,

  async fetchPage(cursor, _config, signal): Promise<SyncPage> {
    const page = cursor ? Number.parseInt(cursor, 10) : 0;
    if (Number.isNaN(page)) {
      throw new Error(`SAOS adapter: invalid cursor "${cursor}"`);
    }

    const params = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      pageNumber: String(page),
      sortingField: "JUDGMENT_DATE",
      sortingDirection: "DESC",
    });

    const url = `${BASE_URL}?${params}`;

    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`SAOS API error: ${response.status}`);
    }

    const data: SaosResponse = await response.json();
    const items = data.items ?? [];
    const decisions: IngestionResult[] = [];

    for (const item of items) {
      const parsed = parseItem(item);
      if (parsed) {
        decisions.push(parsed);
      }
    }

    const total = data.info?.totalResults;
    const fetched = page * PAGE_SIZE + items.length;
    const nextCursor =
      items.length >= PAGE_SIZE && (total == null || fetched < total)
        ? String(page + 1)
        : null;

    return { decisions, nextCursor };
  },
};
