import { Result } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/**
 * Czech Supreme Administrative Court adapter.
 *
 * vyhledavac.nssoud.cz added antiforgery protection and no
 * longer accepts direct JSON POST requests. The adapter now
 * follows the full ASP.NET form submission flow:
 *
 * 1. GET /  -- extract antiforgery cookie, token, form fields
 * 2. POST /Home/Index  -- date range search to execute query
 * 3. POST /Home/MyResTRowsCont  -- paginate with currParams
 *
 * Results are HTML table rows parsed for case metadata.
 *
 * Cursor format: "YYYY-MM-DD:page" where page is 0-indexed.
 * A null cursor starts 30 days ago at page 0.
 */

const BASE_URL = "https://vyhledavac.nssoud.cz";
const RESULTS_PER_PAGE = 20;

/** Default lookback when no cursor is provided. */
const DEFAULT_LOOKBACK_DAYS = 30;

/** Extract a hidden input value from HTML by field name. */
const extractHiddenField = (html: string, name: string): string | undefined => {
  const pattern = new RegExp(
    `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`,
    "i",
  );
  const match = html.match(pattern);
  return match?.[1];
};

/**
 * Extract all hidden form fields from the page.
 * Uses lookaheads to match type, name, and value attributes
 * regardless of their ordering (ASP.NET emits attributes in
 * varying order: name-type-value, type-name-value, etc.).
 */
const extractHiddenFields = (html: string): Map<string, string> => {
  const fields = new Map<string, string>();

  const pattern =
    /<input\b(?=[^>]*\btype=["']hidden["'])(?=[^>]*\bname=["']([^"']*)["'])(?=[^>]*\bvalue=["']([^"']*)["'])[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      fields.set(name, value);
    }
  }

  return fields;
};

/** Extract the __RequestVerificationToken from HTML. */
const extractAntiforgeryToken = (html: string): string | undefined =>
  extractHiddenField(html, "__RequestVerificationToken");

/**
 * Extract the currParams value from the search results page.
 * This is a URL-encoded string that the server needs for
 * pagination via MyResTRowsCont.
 */
const extractCurrParams = (html: string): string | undefined => {
  // currParams is passed to the JavaScript pagination function
  const match = html.match(/currParams\s*[:=]\s*["']([^"']+)["']/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  // Fallback: look for it as a hidden field
  return extractHiddenField(html, "currParams");
};

/**
 * Collect cookies from a response's Set-Cookie headers.
 * Returns a combined cookie string for reuse.
 */
const extractCookies = (response: Response): string => {
  const cookies: string[] = [];

  for (const setCookie of response.headers.getSetCookie()) {
    const pair = setCookie.split(";")[0];
    if (pair) {
      cookies.push(pair);
    }
  }

  return cookies.join("; ");
};

/**
 * Merge incoming cookies into existing ones, overwriting
 * duplicates by name to avoid sending stale values.
 */
const mergeCookies = (existing: string, incoming: string): string => {
  const map = new Map<string, string>();

  for (const pair of existing.split("; ")) {
    const name = pair.split("=")[0];
    if (name) {
      map.set(name, pair);
    }
  }

  for (const pair of incoming.split("; ")) {
    const name = pair.split("=")[0];
    if (name) {
      map.set(name, pair);
    }
  }

  return [...map.values()].join("; ");
};

/** Format a Date as DD.MM.YYYY for the NSS search form. */
const formatCzDate = (date: Date): string => {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
};

/** Parse YYYY-MM-DD cursor date to a Date. */
const parseCursorDate = (dateStr: string): Date => {
  const parts = dateStr.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return new Date(Date.UTC(year, month - 1, day));
};

/** Advance to next day as YYYY-MM-DD. */
const nextDay = (dateStr: string): string => {
  const date = parseCursorDate(dateStr);
  date.setUTCDate(date.getUTCDate() + 1);
  const iso = date.toISOString().split("T")[0];
  if (!iso) {
    throw new Error(`Failed to format date from ${dateStr}`);
  }
  return iso;
};

/** Today's date as YYYY-MM-DD. */
const todayIso = (): string => {
  const iso = new Date().toISOString().split("T")[0];
  return iso ?? "1970-01-01";
};

type ParsedRow = {
  caseNumber: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  outcome: string | undefined;
  documentUrl: string | undefined;
};

/**
 * Parse HTML table rows from the search results.
 * Each row contains: checkbox, case number, date, type,
 * outcome, and a link to the full text.
 */
const parseResultRows = (html: string): ParsedRow[] => {
  const rows: ParsedRow[] = [];

  const rowPattern =
    /<tr[^>]*class=["'][^"']*rslt[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (!rowHtml) {
      continue;
    }

    // Extract all <td> cell contents
    const cells: string[] = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      if (cellMatch[1] !== undefined) {
        cells.push(stripHtml(cellMatch[1]));
      }
    }

    // Extract link to document
    const linkMatch = rowHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/i);
    const documentUrl = linkMatch?.[1]
      ? linkMatch[1].startsWith("http")
        ? linkMatch[1]
        : `${BASE_URL}${linkMatch[1]}`
      : undefined;

    // cells[0] = checkbox, [1] = case number,
    // [2] = date, [3] = type, [4] = outcome
    const caseNumber = cells[1]?.trim();
    if (!caseNumber) {
      continue;
    }

    rows.push({
      caseNumber,
      decisionDate: cells[2]?.trim() || undefined,
      decisionType: cells[3]?.trim() || undefined,
      outcome: cells[4]?.trim() || undefined,
      documentUrl,
    });
  }

  return rows;
};

/** Convert a parsed row into an IngestionResult. */
const rowToResult = (row: ParsedRow): IngestionResult => {
  const raw = `${row.caseNumber}|${row.decisionDate ?? ""}|${row.decisionType ?? ""}`;

  return {
    caseNumber: row.caseNumber,
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    decisionDate: row.decisionDate ? parseCeDate(row.decisionDate) : undefined,
    decisionType: row.decisionType?.toLowerCase(),
    sourceUrl: row.documentUrl,
    documentUrl: row.documentUrl,
    metadata: {
      outcome: row.outcome,
    },
    rawHash: hashContent(raw),
  };
};

type SessionState = {
  cookies: string;
  token: string;
  hiddenFields: Map<string, string>;
};

/**
 * Establish a session: GET the homepage to extract the
 * antiforgery cookie, token, and hidden form fields.
 */
const initSession = async (signal: AbortSignal): Promise<SessionState> => {
  const response = await fetch(BASE_URL, {
    signal,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `NSS session init failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
      cursor: null,
      httpStatus: response.status,
    });
  }

  const html = await response.text();
  const cookies = extractCookies(response);
  const token = extractAntiforgeryToken(html);

  if (!token) {
    throw new AdapterFetchError({
      message: "NSS: antiforgery token not found",
      adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
      cursor: null,
    });
  }

  return { cookies, token, hiddenFields: extractHiddenFields(html) };
};

/**
 * Execute a search for a specific date by submitting the
 * form to /Home/Index with the date range set to one day.
 *
 * Returns the results HTML and the currParams for pagination.
 */
const executeSearch = async (
  session: SessionState,
  date: string,
  signal: AbortSignal,
): Promise<{ html: string; currParams: string | undefined }> => {
  const czDate = formatCzDate(parseCursorDate(date));

  const formData = new URLSearchParams();

  for (const [name, value] of session.hiddenFields) {
    formData.set(name, value);
  }

  formData.set("__RequestVerificationToken", session.token);
  formData.set("DatumOd", czDate);
  formData.set("DatumDo", czDate);

  const response = await fetch(`${BASE_URL}/Home/Index`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookies,
      Referer: BASE_URL,
    },
    body: formData.toString(),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `NSS search failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
      cursor: date,
      httpStatus: response.status,
    });
  }

  // Merge any new cookies (overwriting stale names)
  const newCookies = extractCookies(response);
  if (newCookies) {
    session.cookies = mergeCookies(session.cookies, newCookies);
  }

  const html = await response.text();
  const currParams = extractCurrParams(html);

  return { html, currParams };
};

/**
 * Fetch a specific page of results using the currParams
 * obtained from the initial search.
 *
 * @param date - The date being searched (for error context)
 */
const fetchResultPage = async (
  session: SessionState,
  currParams: string,
  date: string,
  page: number,
  signal: AbortSignal,
): Promise<string> => {
  const formData = new URLSearchParams();
  formData.set("currParams", currParams);
  formData.set("page", String(page));

  const response = await fetch(`${BASE_URL}/Home/MyResTRowsCont`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookies,
      Referer: `${BASE_URL}/Home/Index`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `NSS pagination failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
      cursor: `${date}:${page}`,
      httpStatus: response.status,
    });
  }

  return await response.text();
};

/** Parse cursor string "YYYY-MM-DD:page" or null. */
const parseCursor = (cursor: string | null): { date: string; page: number } => {
  if (!cursor) {
    const lookback = new Date(
      Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const iso = lookback.toISOString().split("T")[0];
    return { date: iso ?? "1970-01-01", page: 0 };
  }

  const separatorIndex = cursor.lastIndexOf(":");
  if (separatorIndex === -1) {
    return { date: cursor, page: 0 };
  }

  const date = cursor.slice(0, separatorIndex);
  const page = Number.parseInt(cursor.slice(separatorIndex + 1), 10);

  return {
    date,
    page: Number.isNaN(page) ? 0 : page,
  };
};

export const czSupremeAdminAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
  name: "Czech Supreme Administrative Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 2000,
  pageTimeoutMs: 60_000,

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        // Use the full page timeout (60s) rather than
        // ADAPTER_TIMEOUT.LIST (15s) because each fetchPage
        // makes 2-3 sequential HTTP requests.
        const timeoutSignal = AbortSignal.timeout(60_000);
        const effectiveSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;

        const { date, page } = parseCursor(cursor);
        const today = todayIso();

        // If the date is in the future, we are done
        if (date > today) {
          return { decisions: [], nextCursor: null };
        }

        // 1. Establish session
        const session = await initSession(effectiveSignal);

        // 2. Execute search for this date
        const searchResult = await executeSearch(
          session,
          date,
          effectiveSignal,
        );

        let html: string;

        if (page === 0) {
          // First page comes from the search response
          html = searchResult.html;
        } else if (searchResult.currParams) {
          // Subsequent pages via pagination endpoint.
          // The adapter is stateless: each fetchPage call
          // re-establishes a session and re-executes the
          // search to obtain fresh currParams. This costs
          // ~1.5x requests vs caching sessions across calls,
          // but avoids serializing server-side state into
          // cursors and keeps the adapter resumable from any
          // cursor without external dependencies.
          html = await fetchResultPage(
            session,
            searchResult.currParams,
            date,
            page,
            effectiveSignal,
          );
        } else {
          // No currParams = no results; advance day
          const next = nextDay(date);
          return {
            decisions: [],
            nextCursor: next <= today ? `${next}:0` : null,
          };
        }

        const rows = parseResultRows(html);
        const decisions: IngestionResult[] = [];

        for (const row of rows) {
          decisions.push(rowToResult(row));
        }

        // Determine next cursor
        if (rows.length >= RESULTS_PER_PAGE && searchResult.currParams) {
          // More pages for this date
          return {
            decisions,
            nextCursor: `${date}:${page + 1}`,
          };
        }

        // No more pages; advance to next day
        const next = nextDay(date);
        return {
          decisions,
          nextCursor: next <= today ? `${next}:0` : null,
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_SUPREME_ADMIN, cursor),
    });
  },
};
