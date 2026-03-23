import { Result } from "better-result";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/**
 * Czech Regional Courts adapter.
 *
 * Fetches decisions from the rozhodnuti.justice.cz open data
 * JSON API. The API uses a hierarchical date structure:
 *
 *   /api/opendata/{year}/{month}/{day}?page={n}
 *
 * Each day may contain multiple pages (100 items/page).
 * Fulltext is not inline; a separate /api/finaldoc/{uuid}
 * endpoint provides the full document.
 *
 * Cursor format: "YYYY-MM-DD:page" (e.g. "2026-03-01:0").
 * Pages are 0-indexed. A null cursor starts from 30 days ago.
 */

const BASE_URL = "https://rozhodnuti.justice.cz/api";

/** Shape of a single item in the paginated day response. */
type CzRegionalApiItem = {
  jednaciCislo?: string;
  ecli?: string;
  soud?: string;
  autor?: string;
  predmetRizeni?: string;
  datumVydani?: string;
  datumZverejneni?: string;
  klicovaSlova?: string[];
  zminenaUstanoveni?: string[];
  odkaz?: string;
};

/** Paginated response from /api/opendata/{y}/{m}/{d}. */
type CzRegionalPageResponse = {
  items?: CzRegionalApiItem[];
  totalPages?: number;
  pageNumber?: number;
};

/** Response shape from /api/finaldoc/{uuid}. */
type CzRegionalFinaldoc = {
  verdictText?: string;
  justificationText?: string;
  metadata?: {
    type?: string;
  };
};

/**
 * Fetch fulltext from the /api/finaldoc/{uuid} endpoint.
 * Returns concatenated verdict + justification text.
 */
const fetchFulltext = async (
  docUrl: string,
  signal?: AbortSignal,
): Promise<{
  fulltext: string | undefined;
  decisionType: string | undefined;
}> => {
  try {
    const response = await fetch(docUrl, {
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
          ])
        : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return { fulltext: undefined, decisionType: undefined };
    }

    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- finaldoc API contract
    const doc = (await response.json()) as CzRegionalFinaldoc;

    const parts: string[] = [];
    if (doc.verdictText) {
      parts.push(doc.verdictText);
    }
    if (doc.justificationText) {
      parts.push(doc.justificationText);
    }

    return {
      fulltext: parts.length > 0 ? parts.join("\n\n") : undefined,
      decisionType: doc.metadata?.type?.toLowerCase(),
    };
  } catch {
    return { fulltext: undefined, decisionType: undefined };
  }
};

const parseItem = (item: CzRegionalApiItem): IngestionResult | null => {
  if (!item.jednaciCislo || !item.soud) {
    return null;
  }

  const raw = JSON.stringify(item);

  return {
    caseNumber: item.jednaciCislo,
    ecli: item.ecli,
    court: item.soud,
    country: "CZE",
    language: "cs",
    decisionDate: item.datumVydani,
    sourceUrl: item.odkaz,
    documentUrl: item.odkaz,
    metadata: {
      author: item.autor,
      subjectOfProceeding: item.predmetRizeni,
      publishedDate: item.datumZverejneni,
      keywords: item.klicovaSlova,
      mentionedStatutes: item.zminenaUstanoveni,
    },
    rawHash: hashContent(raw),
  };
};

type CursorState = { date: string; page: number };

const parseCursor = (cursor: string): CursorState => {
  const colonIdx = cursor.lastIndexOf(":");
  if (colonIdx === -1) {
    return { date: cursor, page: 0 };
  }

  const date = cursor.slice(0, colonIdx);
  const page = Number.parseInt(cursor.slice(colonIdx + 1), 10);

  return {
    date,
    page: Number.isNaN(page) ? 0 : page,
  };
};

const makeCursor = (state: CursorState): string =>
  `${state.date}:${state.page}`;

/** Build the day endpoint URL from a YYYY-MM-DD date. */
const buildDayUrl = (date: string, page: number): string => {
  const parts = date.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;

  return `${BASE_URL}/opendata/${year}/${month}/${day}?page=${page}`;
};

/** Advance a YYYY-MM-DD string by one day. */
const nextDay = (dateStr: string): string => {
  const parts = dateStr.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  const iso = date.toISOString().split("T")[0];
  if (!iso) {
    throw new Error(`Failed to format date from ${dateStr}`);
  }
  return iso;
};

const todayIso = (): string =>
  new Date().toISOString().split("T")[0] ?? "1970-01-01";

const defaultDate = (): string =>
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0] ??
  "1970-01-01";

export const czRegionalAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_REGIONAL,
  name: "Czech Regional Courts",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 1000,

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const state: CursorState = cursor
          ? parseCursor(cursor)
          : { date: defaultDate(), page: 0 };

        const url = buildDayUrl(state.date, state.page);

        const response = await fetch(url, {
          signal: signal ?? AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          // 404 means no data for this date; advance cursor
          if (response.status === 404) {
            const today = todayIso();
            const next = nextDay(state.date);

            return {
              decisions: [],
              nextCursor:
                next <= today ? makeCursor({ date: next, page: 0 }) : null,
            };
          }

          throw new AdapterFetchError({
            message: `CZ Regional API error: ${response.status}`,
            adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            cursor,
            httpStatus: response.status,
          });
        }

        // SAFETY: response shape validated by optional fields in CzRegionalPageResponse
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const json = (await response.json()) as CzRegionalPageResponse;
        const items = json.items ?? [];

        const decisions: IngestionResult[] = [];
        for (const item of items) {
          const parsed = parseItem(item);
          if (parsed) {
            decisions.push(parsed);
          }
        }

        // Enrich decisions with fulltext from /api/finaldoc
        for (const decision of decisions) {
          if (!decision.documentUrl) {
            continue;
          }

          const { fulltext, decisionType } = await fetchFulltext(
            decision.documentUrl,
            signal,
          );

          if (fulltext) {
            decision.fulltext = fulltext;
          }
          if (decisionType) {
            decision.decisionType = decisionType;
          }
        }

        const totalPages = json.totalPages ?? 1;

        // Use state.page (what we requested) instead of
        // json.pageNumber (what the API echoed back) to
        // avoid an infinite loop if the API ever returns
        // a stale or incorrect pageNumber.
        const currentPage = state.page;

        // More pages for this day: advance page (0-indexed)
        if (currentPage + 1 < totalPages) {
          return {
            decisions,
            nextCursor: makeCursor({
              date: state.date,
              page: currentPage + 1,
            }),
          };
        }

        // Day exhausted: advance to next day
        const today = todayIso();
        const next = nextDay(state.date);

        return {
          decisions,
          nextCursor:
            next <= today ? makeCursor({ date: next, page: 0 }) : null,
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_REGIONAL, cursor),
    });
  },
};
