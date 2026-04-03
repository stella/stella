import { panic, Result } from "better-result";

import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/**
 * Czech Supreme Administrative Court adapter.
 *
 * vyhledavac.nssoud.cz uses ASP.NET antiforgery protection
 * with a complex vyhledavaciSekce form model (2025 redesign).
 *
 * Flow:
 * 1. GET /  -- extract antiforgery cookie, token, ALL form
 *    fields (hidden + text inputs for vyhledavaciSekce model)
 * 2. POST /Home/Index  -- submit form with date criteria in
 *    vyhledavaciSekce[1] date fields, returns currParams
 * 3. Page 0 results are inline in the search response.
 *    Pages 1+ use POST /Home/MyResTRowsCont (AJAX pagination)
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
 * Extract all form fields from the page (hidden + text inputs).
 * The 2025+ redesign moved date criteria from top-level
 * DatumOd/DatumDo fields into nested vyhledavaciSekce
 * text inputs. Both hidden and text inputs must be submitted
 * for the ASP.NET model binder to accept the form.
 */
const extractFormFields = (html: string): Map<string, string> => {
  const fields = new Map<string, string>();

  // Hidden inputs (token, FormularCiselnik, etc.)
  const hiddenPattern =
    /<input\b(?=[^>]*\btype=["']hidden["'])(?=[^>]*\bname=["']([^"']*)["'])(?=[^>]*\bvalue=["']([^"']*)["'])[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hiddenPattern.exec(html)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1], match[2]);
    }
  }

  // Text inputs (date fields in vyhledavaciSekce)
  const textPattern =
    /<input[^>]*\btype=["']text["'][^>]*\bname=["']([^"']*)["'][^>]*>/gi;
  while ((match = textPattern.exec(html)) !== null) {
    if (match[1] && !fields.has(match[1])) {
      fields.set(match[1], "");
    }
  }

  // Also try reversed order (name before type)
  const textPattern2 =
    /<input[^>]*\bname=["']([^"']*)["'][^>]*\btype=["']text["'][^>]*>/gi;
  while ((match = textPattern2.exec(html)) !== null) {
    if (match[1] && !fields.has(match[1])) {
      fields.set(match[1], "");
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
    panic(`Failed to format date from ${dateStr}`);
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
  /** Numeric document ID for fetching fulltext via /DokumentOriginal/Text/{id}. */
  documentId: string | undefined;
};

/**
 * Parse result rows from the search response HTML.
 *
 * The 2025 redesign renders results as <tbody> blocks
 * with citation <a title="Citace: ... čj. X"> elements.
 */
const parseResultRows = (html: string): ParsedRow[] => {
  const rows: ParsedRow[] = [];

  const tbodyPattern = /<tbody>([\s\S]*?)<\/tbody>/gi;
  let tbodyMatch: RegExpExecArray | null;

  while ((tbodyMatch = tbodyPattern.exec(html)) !== null) {
    const block = tbodyMatch[1];
    if (!block?.includes("Citace")) {
      continue;
    }

    // č may appear as literal or HTML entity (&#x10D; &#x10d; &#269;)
    // Stop at comma to exclude publication reference (e.g. ", č. 421/2004 Sb. NSS")
    const citMatch = block.match(
      /title="Citace:[^"]*?(?:čj\.|č\.\s*j\.|&#x10[dD];j\.|&#26[89];j\.)[\s]*([^",]+?)(?:-\d+)?[",]/i,
    );
    const caseNumber = citMatch?.[1]?.trim();
    if (!caseNumber || caseNumber.length > 100) {
      // Skip malformed or overly long case numbers
      if (caseNumber) {
        // eslint-disable-next-line no-console -- adapter diagnostic
        console.warn(
          `NSS: skipping malformed case number (${caseNumber.length} chars): ${caseNumber.slice(0, 50)}`,
        );
      }
      continue;
    }

    const detailMatch = block.match(/href="\/DokumentDetail\/Index\/(\d+)"/);
    const documentId = detailMatch?.[1];
    const documentUrl = documentId
      ? `${BASE_URL}/DokumentDetail/Index/${documentId}`
      : undefined;

    const cells: string[] = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(block)) !== null) {
      if (cellMatch[1]) {
        cells.push(stripHtml(cellMatch[1]).trim());
      }
    }

    let decisionDate: string | undefined;
    let decisionType: string | undefined;
    for (const cell of cells) {
      if (!decisionDate && /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/.test(cell)) {
        decisionDate = cell;
      } else if (
        !decisionType &&
        cell !== caseNumber &&
        cell.length > 2 &&
        cell.length < 50 &&
        !/^\d+$/.test(cell)
      ) {
        decisionType = cell;
      }
    }

    rows.push({
      caseNumber,
      decisionDate,
      decisionType,
      outcome: undefined,
      documentUrl,
      documentId,
    });
  }

  return rows;
};

type DecisionContent = {
  fulltext: string | undefined;
  documentAst: DocumentAst | EmptyAst | undefined;
  sourceRaw: string | undefined;
};

/**
 * Fetch rich HTML from /DokumentOriginal/Html/{id} and parse
 * it into a DocumentAst. Falls back to /Text/{id} for plain
 * fulltext if the rich endpoint fails.
 */
const fetchDecisionContent = async (
  documentId: string,
  row: ParsedRow,
  detail: DetailMetadata,
  session: SessionState,
  signal: AbortSignal,
): Promise<DecisionContent> => {
  // Try rich HTML first
  try {
    const response = await fetch(
      `${BASE_URL}/DokumentOriginal/Html/${documentId}`,
      {
        signal,
        headers: {
          ...COMMON_HEADERS,
          Cookie: session.cookies,
        },
      },
    );

    if (response.ok) {
      const html = await response.text();
      if (html.length > 200 && !html.includes("<body>\n    N/A\n</body>")) {
        const parsed = parseNssDecisionHtml({
          caseNumber: row.caseNumber,
          ecli: detail.ecli,
          court: "Nejvyšší správní soud",
          decisionDate: detail.decisionDate
            ? parseCeDate(detail.decisionDate)
            : row.decisionDate
              ? parseCeDate(row.decisionDate)
              : undefined,
          decisionType: (
            detail.decisionType ?? row.decisionType
          )?.toLowerCase(),
          sourceUrl: row.documentUrl,
          html,
          detailMetadata: { ...detail },
        });

        return {
          fulltext: parsed.fulltext,
          documentAst: parsed.documentAst,
          sourceRaw: html,
        };
      }
    }
  } catch {
    // Fall through to plain text
  }

  // Fallback: plain text from /Text/{id}
  try {
    const response = await fetch(
      `${BASE_URL}/DokumentOriginal/Text/${documentId}`,
      {
        signal,
        headers: {
          ...COMMON_HEADERS,
          Cookie: session.cookies,
        },
      },
    );

    if (!response.ok) {
      return {
        fulltext: undefined,
        documentAst: undefined,
        sourceRaw: undefined,
      };
    }

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder("utf-16").decode(buffer);
    const body = stripHtml(text);
    return {
      fulltext: body.length > 100 ? body : undefined,
      documentAst: undefined,
      sourceRaw: undefined,
    };
  } catch {
    return {
      fulltext: undefined,
      documentAst: undefined,
      sourceRaw: undefined,
    };
  }
};

type DetailMetadata = {
  ecli: string | undefined;
  judge: string | undefined;
  senate: string | undefined;
  legalArea: string | undefined;
  decisionType: string | undefined;
  decisionDate: string | undefined;
  outcome: string | undefined;
  caseType: string | undefined;
  parties: string | undefined;
  caseStatus: string | undefined;
  administrativeAuthority: string | undefined;
  citation: string | undefined;
};

/** Extract a div's value text by its ID, skipping the label span. */
const extractDivText = (html: string, divId: string): string | undefined => {
  const pattern = new RegExp(`id="${divId}"[^>]*>([\\s\\S]*?)</div>`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  // Structure: <span class="det-textitle">Label:</span>
  //            <span class="det-textval" title="Value">Value</span>
  const valPattern = /class="det-textval[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  let valMatch: RegExpExecArray | null;
  const texts: string[] = [];
  while ((valMatch = valPattern.exec(match[1])) !== null) {
    const text = stripHtml(valMatch[1] ?? "").trim();
    if (text) {
      texts.push(text);
    }
  }
  if (texts.length > 0) {
    return texts.join(", ");
  }

  return undefined;
};

/**
 * Fetch structured metadata from /DokumentDetail/Index/{id}.
 * Extracts ECLI, judge, legal area, decision type, outcome,
 * case type, and parties.
 */
const EMPTY_DETAIL: DetailMetadata = {
  ecli: undefined,
  judge: undefined,
  senate: undefined,
  legalArea: undefined,
  decisionType: undefined,
  decisionDate: undefined,
  outcome: undefined,
  caseType: undefined,
  parties: undefined,
  caseStatus: undefined,
  administrativeAuthority: undefined,
  citation: undefined,
};

const fetchDetailMetadata = async (
  documentId: string,
  session: SessionState,
  signal: AbortSignal,
): Promise<DetailMetadata> => {
  const empty = EMPTY_DETAIL;

  try {
    const response = await fetch(
      `${BASE_URL}/DokumentDetail/Index/${documentId}`,
      {
        signal,
        headers: {
          ...COMMON_HEADERS,
          Cookie: session.cookies,
        },
      },
    );
    if (!response.ok) {
      return empty;
    }

    const html = await response.text();

    return {
      ecli: extractDivText(html, "ecli"),
      judge: extractDivText(html, "soudcezpravodaj"),
      senate: extractDivText(html, "soudsenat"),
      legalArea: extractDivText(html, "oblastupravy"),
      decisionType: extractDivText(html, "druhdokumentuavyrokrozhodnuti"),
      decisionDate: extractDivText(html, "datumvydanirozhodnuti"),
      outcome: extractDivText(html, "vyrokrozhodnuti"),
      caseType: extractDivText(html, "typrizeni"),
      parties: extractDivText(html, "ucastnicirizeniz"),
      caseStatus: extractDivText(html, "stavrizeni"),
      administrativeAuthority: extractDivText(html, "nazevspravnihoorganu"),
      citation: extractDivText(html, "citace"),
    };
  } catch {
    return empty;
  }
};

/** Convert a parsed row into an IngestionResult. */
const rowToResult = (
  row: ParsedRow,
  content: DecisionContent,
  detail: DetailMetadata,
): IngestionResult => {
  // Hash must be stable across runs regardless of transient
  // network failures — never include fulltext in the hash.
  const raw = `${row.caseNumber}|${row.decisionDate ?? ""}|${row.decisionType ?? ""}`;

  return {
    caseNumber: row.caseNumber,
    ecli: detail.ecli,
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    decisionDate: detail.decisionDate
      ? parseCeDate(detail.decisionDate)
      : row.decisionDate
        ? parseCeDate(row.decisionDate)
        : undefined,
    // Prefer structured decisionType from detail page over
    // the heuristic cell match from the search results table
    decisionType: (detail.decisionType ?? row.decisionType)?.toLowerCase(),
    fulltext: content.fulltext,
    sourceUrl: row.documentUrl,
    documentUrl: row.documentUrl,
    metadata: {
      caseNumber: row.caseNumber,
      court: "Nejvyšší správní soud" as const,
      ecli: detail.ecli,
      judge: detail.judge,
      senate: detail.senate,
      legalArea: detail.legalArea,
      decisionType: detail.decisionType,
      decisionDate: detail.decisionDate,
      outcome: detail.outcome ?? row.outcome,
      caseType: detail.caseType,
      parties: detail.parties,
      caseStatus: detail.caseStatus,
      administrativeAuthority: detail.administrativeAuthority,
      citation: detail.citation,
    },
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSION,
    documentAst: content.documentAst ?? EMPTY_AST,
    sourceRaw: content.sourceRaw,
    sourceRawContentType: "text/html",
  };
};

type SessionState = {
  cookies: string;
  token: string;
  formFields: Map<string, string>;
};

/** Common headers for all requests to the NSS website. */
const COMMON_HEADERS = {
  "User-Agent": INGESTION_USER_AGENT,
} as const;

/**
 * Session cache. The NSS website uses ASP.NET antiforgery
 * tokens that are valid for the duration of the session cookie
 * (typically 20-30 minutes). Creating a new session per
 * fetchPage call triggers rate limiting after ~10-20 requests.
 *
 * We cache the session and reuse it across calls. If a search
 * returns an unexpected result (e.g., redirect to login), we
 * invalidate and retry with a fresh session.
 */
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cachedSession: {
  state: SessionState;
  createdAt: number;
} | null = null;

const initSession = async (signal: AbortSignal): Promise<SessionState> => {
  const response = await fetch(BASE_URL, {
    signal,
    redirect: "follow",
    headers: COMMON_HEADERS,
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `NSS session init failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
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
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      cursor: null,
    });
  }

  return { cookies, token, formFields: extractFormFields(html) };
};

/**
 * Get or create a session. Reuses the cached session if it
 * is still within TTL, otherwise creates a fresh one.
 */
const getSession = async (signal: AbortSignal): Promise<SessionState> => {
  if (cachedSession && Date.now() - cachedSession.createdAt < SESSION_TTL_MS) {
    return cachedSession.state;
  }

  const state = await initSession(signal);
  cachedSession = { state, createdAt: Date.now() };
  return state;
};

/** Invalidate the cached session (e.g., after a failed request). */
const invalidateSession = () => {
  cachedSession = null;
};

/**
 * Execute a search for a specific date by submitting the
 * form to /Home/Index with the date range set to one day.
 *
 * Returns the results HTML and the currParams for pagination.
 */
/** Date field paths in the vyhledavaciSekce form model. */
const DATE_FROM_FIELD =
  "vyhledavaciSekce[1].vyhledavaciPodminka[0]" +
  ".vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd";
const DATE_TO_FIELD =
  "vyhledavaciSekce[1].vyhledavaciPodminka[0]" +
  ".vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo";

const executeSearch = async (
  session: SessionState,
  date: string,
  signal: AbortSignal,
): Promise<{ html: string; currParams: string | undefined }> => {
  const czDate = formatCzDate(parseCursorDate(date));

  const formData = new URLSearchParams();

  for (const [name, value] of session.formFields) {
    formData.set(name, value);
  }

  formData.set("__RequestVerificationToken", session.token);
  formData.set(DATE_FROM_FIELD, czDate);
  formData.set(DATE_TO_FIELD, czDate);

  const response = await fetch(`${BASE_URL}/Home/Index`, {
    method: "POST",
    signal,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookies,
      Referer: BASE_URL,
    },
    body: formData.toString(),
    redirect: "follow",
  });

  if (!response.ok) {
    invalidateSession();
    throw new AdapterFetchError({
      message: `NSS search failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
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
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookies,
      Referer: `${BASE_URL}/Home/Index`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    invalidateSession();
    throw new AdapterFetchError({
      message: `NSS pagination failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
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

export const czNssAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_NSS,
  name: "Czech Supreme Administrative Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 500,
  // Each page = 1 day = session + search + fulltext per decision.
  // With ~20 decisions/day and fulltext fetches, ~30s/page.
  pageTimeoutMs: 120_000,
  maxSyncPages: 20,

  async getTotalCount(signal) {
    try {
      const session = await getSession(signal);

      // Submit empty search (no date filters = all results)
      const formData = new URLSearchParams();
      for (const [name, value] of session.formFields) {
        formData.set(name, value);
      }
      formData.set("__RequestVerificationToken", session.token);

      const response = await fetch(`${BASE_URL}/Home/Index`, {
        method: "POST",
        signal,
        headers: {
          ...COMMON_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: session.cookies,
          Referer: BASE_URL,
        },
        body: formData.toString(),
        redirect: "follow",
      });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();

      const countPatterns = [
        /Nalezeno\s+(\d[\d\s]*)\s+záznam/i,
        /Celkem\s+(\d[\d\s]*)\s+záznam/i,
        /(\d[\d\s]*)\s+výsledk/i,
        /resCount[^>]*>(\d[\d\s]*)</i,
        /myResCount[^>]*>(\d[\d\s]*)</i,
        /pocetZaznamu[^>]*>(\d[\d\s]*)</i,
      ];

      for (const pattern of countPatterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
          const cleaned = match[1].replace(/\s/g, "");
          const parsed = Number.parseInt(cleaned, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            return parsed;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        // Use the full page timeout (matches pageTimeoutMs)
        // because each fetchPage makes session + search +
        // fulltext fetches per decision.
        const timeoutSignal = AbortSignal.timeout(120_000);
        const effectiveSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;

        const { date, page } = parseCursor(cursor);
        const today = todayIso();

        // If the date is in the future, park at today so we
        // only re-check today on the next cycle (never null —
        // null restarts from DEFAULT_LOOKBACK_DAYS ago).
        if (date > today) {
          return { decisions: [], nextCursor: `${today}:0` };
        }

        // 1. Get or reuse session
        const session = await getSession(effectiveSignal);

        // 2. Execute search for this date
        const searchResult = await executeSearch(
          session,
          date,
          effectiveSignal,
        );

        if (!searchResult.currParams || searchResult.currParams === "[]") {
          // No results for this date; advance to next day
          const next = nextDay(date);
          return {
            decisions: [],
            nextCursor: next <= today ? `${next}:0` : `${today}:0`,
          };
        }

        let html: string;

        if (page === 0) {
          // Page 0 results are inline in the search response
          html = searchResult.html;
        } else {
          html = await fetchResultPage(
            session,
            searchResult.currParams,
            date,
            page,
            effectiveSignal,
          );
        }

        const rows = parseResultRows(html);
        const decisions: IngestionResult[] = [];

        for (const row of rows) {
          let detail: DetailMetadata = EMPTY_DETAIL;

          if (row.documentId) {
            // Fetch detail metadata first (needed by parser)
            detail = await fetchDetailMetadata(
              row.documentId,
              session,
              effectiveSignal,
            );
          }

          let content: DecisionContent = {
            fulltext: undefined,
            documentAst: undefined,
            sourceRaw: undefined,
          };

          if (row.documentId) {
            content = await fetchDecisionContent(
              row.documentId,
              row,
              detail,
              session,
              effectiveSignal,
            );
          }

          decisions.push(rowToResult(row, content, detail));
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
          nextCursor: next <= today ? `${next}:0` : `${today}:0`,
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_NSS, cursor),
    });
  },
};
