import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obicn.justice.sk pilot JSON API.
 * Page-based pagination (25 items per page).
 *
 * Cursor format: page number as string (e.g. "1", "2").
 */

const BASE_URL = "https://obicn.justice.sk/pilot/api/decisions";
const PAGE_SIZE = 25;

const hashResult = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

type SkApiItem = {
  caseNumber?: string;
  ecli?: string;
  court?: string;
  decisionDate?: string;
  judge?: string;
  decisionForm?: string;
  decisionNature?: string;
  field?: string;
  fulltext?: string;
  url?: string;
};

const parseItem = (item: SkApiItem): IngestionResult | null => {
  if (!item.caseNumber || !item.court) {
    return null;
  }

  const raw = JSON.stringify(item);

  return {
    caseNumber: item.caseNumber,
    ecli: item.ecli,
    court: item.court,
    country: "SVK",
    language: "sk",
    decisionDate: item.decisionDate,
    decisionType: item.decisionForm,
    fulltext: item.fulltext,
    sourceUrl: item.url,
    documentUrl: item.url,
    metadata: {
      judge: item.judge,
      decisionNature: item.decisionNature,
      field: item.field,
    },
    rawHash: hashResult(raw),
  };
};

export const skCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_COURTS,
  name: "Slovak Courts",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 1000,

  async fetchPage(cursor, _config, signal): Promise<SyncPage> {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;

    const url = `${BASE_URL}?page=${page}&pageSize=${PAGE_SIZE}`;

    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`SK Courts API error: ${response.status}`);
    }

    const items: SkApiItem[] = await response.json();
    const decisions: IngestionResult[] = [];

    for (const item of items) {
      const parsed = parseItem(item);
      if (parsed) {
        decisions.push(parsed);
      }
    }

    const nextCursor = items.length >= PAGE_SIZE ? String(page + 1) : null;

    return { decisions, nextCursor };
  },
};
