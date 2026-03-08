import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";

/**
 * Czech Regional Courts adapter.
 *
 * Fetches decisions from the rozhodnuti.justice.cz open data
 * JSON API. The API is paginated by date; each call returns
 * decisions for a given day.
 *
 * Cursor format: ISO date string (YYYY-MM-DD) representing
 * the next day to fetch.
 */

const BASE_URL = "https://rozhodnuti.justice.cz/api/opendata";

const hashResult = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

type CzRegionalApiItem = {
  case_number?: string;
  ecli?: string;
  court?: string;
  decision_date?: string;
  author?: string;
  subject_of_proceeding?: string;
  mentioned_statutes?: string[];
  fulltext_url?: string;
  fulltext?: string;
};

const parseItem = (item: CzRegionalApiItem): IngestionResult | null => {
  if (!item.case_number || !item.court) {
    return null;
  }

  const raw = JSON.stringify(item);

  return {
    caseNumber: item.case_number,
    ecli: item.ecli,
    court: item.court,
    country: "CZE",
    language: "cs",
    decisionDate: item.decision_date,
    fulltext: item.fulltext,
    sourceUrl: item.fulltext_url,
    documentUrl: item.fulltext_url,
    metadata: {
      author: item.author,
      subjectOfProceeding: item.subject_of_proceeding,
      mentionedStatutes: item.mentioned_statutes,
    },
    rawHash: hashResult(raw),
  };
};

/**
 * Advance the cursor by one day.
 */
const nextDay = (dateStr: string): string => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().split("T")[0];
};

export const czRegionalAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_REGIONAL,
  name: "Czech Regional Courts",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 1000,

  async fetchPage(cursor, _config, signal): Promise<SyncPage> {
    // Default cursor: 30 days ago
    const date =
      cursor ??
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

    const url = `${BASE_URL}/${date}`;

    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      // If 404, the date has no data; advance cursor
      if (response.status === 404) {
        const today = new Date().toISOString().split("T")[0];
        const next = nextDay(date);

        return {
          decisions: [],
          nextCursor: next <= today ? next : null,
        };
      }

      throw new Error(`CZ Regional API error: ${response.status}`);
    }

    const json: unknown = await response.json();
    const items: CzRegionalApiItem[] = Array.isArray(json) ? json : [];

    const decisions: IngestionResult[] = [];
    for (const item of items) {
      const parsed = parseItem(item);
      if (parsed) {
        decisions.push(parsed);
      }
    }

    const today = new Date().toISOString().split("T")[0];
    const next = nextDay(date);

    return {
      decisions,
      nextCursor: next <= today ? next : null,
    };
  },
};
