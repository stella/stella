import { panic, Result } from "better-result";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  defineSourceAdapter,
  EMPTY_AST,
  isPersistableSourceDocumentId,
  STORED_RAW_REPARSE_REJECTION,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import { addUtcDays } from "@/api/lib/dates";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

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
 *
 * The search is addressed by decision date and answers with the court's own
 * record count for it, which is what makes this source reconcilable: a day can
 * be listed on its own, without the crawl cursor ever reaching it. See
 * `reconciliation` at the bottom of this file.
 */

/** The publisher's origin; every document URL is rebuilt from it (rule 21). */
export const NSS_BASE_URL = "https://vyhledavac.nssoud.cz";
const BASE_URL = NSS_BASE_URL;

/** The only language this source publishes. */
const CZ_NSS_LANGUAGE = "cs";

/**
 * The court a row is stored under when nothing states a finer one.
 *
 * The portal also carries the regional and city administrative courts whose
 * judgments the NSS reviews (a single day's listing mixes `1 Az 4/2026` of the
 * Městský soud v Praze with `52 Af 4/2026` of the Krajský soud v Hradci
 * Králové). Neither the row nor the detail fields name the deciding court; the
 * ECLI does, in its court code, so `courtFromEcli` reads it from there and this
 * label covers only documents that carry no ECLI.
 */
const CZ_NSS_COURT = "Nejvyšší správní soud";

/**
 * ECLI court codes the portal publishes under, to the court's name.
 *
 * The list is the one the corpus has shown so far; an unlisted code is
 * reported rather than mapped, and the row keeps the fallback label so the
 * document is still stored.
 */
export const CZ_ECLI_COURTS = {
  NSS: CZ_NSS_COURT,
  MSPH: "Městský soud v Praze",
  KSBR: "Krajský soud v Brně",
  KSCB: "Krajský soud v Českých Budějovicích",
  KSHK: "Krajský soud v Hradci Králové",
  KSOS: "Krajský soud v Ostravě",
  KSPH: "Krajský soud v Praze",
  KSPL: "Krajský soud v Plzni",
  KSUL: "Krajský soud v Ústí nad Labem",
} as const satisfies Record<string, string>;

/** Codes are four letters at most; the bound keeps an odd ECLI out of the log. */
const ECLI_COURT_CODE = /^ECLI:CZ:(?<code>[A-Z]{1,8}):/u;

const isEcliCourtCode = (code: string): code is keyof typeof CZ_ECLI_COURTS =>
  Object.hasOwn(CZ_ECLI_COURTS, code);

/** The deciding court named by an ECLI, or the fallback label. */
export const courtFromEcli = (ecli: string | undefined): string => {
  if (ecli === undefined) {
    return CZ_NSS_COURT;
  }
  const code = ECLI_COURT_CODE.exec(ecli)?.groups?.["code"];
  if (code === undefined) {
    return CZ_NSS_COURT;
  }
  if (isEcliCourtCode(code)) {
    return CZ_ECLI_COURTS[code];
  }
  logger.warn("case_law.ingestion.cz_nss.unknown_ecli_court", { code });
  return CZ_NSS_COURT;
};

/**
 * Rows the portal renders inline on the results page a search returns.
 */
export const CZ_NSS_FIRST_PAGE_ROWS = 40;

/**
 * Rows `/Home/MyResTRowsCont` serves for one `pageNum`, which is half what
 * the inline page carries.
 *
 * The two sizes are separate because the portal's are: a day stating 68
 * records renders 40 inline, then answers `pageNum` 1 with 20 and `pageNum` 2
 * with the last 8. One size for both made every page after the first expect
 * twice the rows it can hold, so every day above 40 decisions failed its own
 * count check and held its slice out of the sweep.
 */
export const CZ_NSS_CONTINUATION_PAGE_ROWS = 20;

/** Rows page `page` of a day carries when the day is larger than it. */
const czNssRowsOnPage = (page: number): number =>
  page === 0 ? CZ_NSS_FIRST_PAGE_ROWS : CZ_NSS_CONTINUATION_PAGE_ROWS;

/** Rows of a day preceding page `page`. */
const czNssRowsBeforePage = (page: number): number =>
  page === 0
    ? 0
    : CZ_NSS_FIRST_PAGE_ROWS + (page - 1) * CZ_NSS_CONTINUATION_PAGE_ROWS;

/**
 * Pages the walk must ask for to see a day of `statedCount` records: the
 * inline one, plus one continuation page per {@link
 * CZ_NSS_CONTINUATION_PAGE_ROWS} beyond it.
 */
export const czNssTotalPages = (statedCount: number): number =>
  statedCount <= 0
    ? 0
    : 1 +
      Math.ceil(
        Math.max(0, statedCount - CZ_NSS_FIRST_PAGE_ROWS) /
          CZ_NSS_CONTINUATION_PAGE_ROWS,
      );

type CzNssExpectedRowsOptions = {
  /** 0-indexed page within the day. */
  page: number;
  /** What the portal says the day holds. */
  statedCount: number;
};

/** Rows page `page` must carry for a day of `statedCount` records. */
export const czNssExpectedRows = ({
  page,
  statedCount,
}: CzNssExpectedRowsOptions): number =>
  Math.max(
    0,
    Math.min(czNssRowsOnPage(page), statedCount - czNssRowsBeforePage(page)),
  );

/**
 * How many records the court says its own search matched, as the results page
 * states it: `<h6>Počet nalezených záznamů: 50</h6>`.
 *
 * Anchored on the label's ASCII-safe stem and the colon that precedes the
 * number, because the page mixes literal Czech text with HTML entities and
 * only the stem is stable under both. The `{0,20}` bound keeps the label span
 * finite, and `[^:<]` stops it crossing into another tag or another colon.
 *
 * The count is grouped ("1 234"), so digit runs may be separated by spaces.
 * `(?:\s\d+)*` keeps the separator and the digits disjoint; a `[\d\s]*` class
 * would overlap the `\s+` that follows, letting the engine re-split every
 * trailing space and costing time quadratic in the length of the page.
 */
const RESULT_COUNT_PATTERN = /nalezen[^:<]{0,20}:\s*(?<count>\d+(?:\s\d+)*)/iu;

/**
 * The count the page states, or `null` where it states none.
 *
 * Zero is an answer, not an absence: a day the court matched nothing for says
 * so, and callers that must tell an empty slice from an unreadable page depend
 * on the difference.
 */
const statedResultCount = (html: string): number | null => {
  const raw = RESULT_COUNT_PATTERN.exec(html)?.groups?.["count"];
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw.replace(/\s/gu, ""), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

/** Default lookback when no cursor is provided. */
const DEFAULT_LOOKBACK_DAYS = 30;

/** Extract a hidden input value from HTML by field name. */
const extractHiddenField = (html: string, name: string): string | undefined => {
  const pattern = new RegExp(
    `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`,
    "iu",
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
    /<input\b(?=[^>]*\btype=["']hidden["'])(?=[^>]*\bname=["'](?<name>[^"']*)["'])(?=[^>]*\bvalue=["'](?<value>[^"']*)["'])[^>]*>/giu;
  let match: RegExpExecArray | null;
  while ((match = hiddenPattern.exec(html)) !== null) {
    const { name, value } = match.groups ?? {};
    if (name !== undefined && value !== undefined) {
      fields.set(name, value);
    }
  }

  // Text inputs (date fields in vyhledavaciSekce)
  const textPattern =
    /<input[^>]*\btype=["']text["'][^>]*\bname=["'](?<name>[^"']*)["'][^>]*>/giu;
  while ((match = textPattern.exec(html)) !== null) {
    const name = match.groups?.["name"];
    if (name && !fields.has(name)) {
      fields.set(name, "");
    }
  }

  // Also try reversed order (name before type)
  const textPattern2 =
    /<input[^>]*\bname=["'](?<name>[^"']*)["'][^>]*\btype=["']text["'][^>]*>/giu;
  while ((match = textPattern2.exec(html)) !== null) {
    const name = match.groups?.["name"];
    if (name && !fields.has(name)) {
      fields.set(name, "");
    }
  }

  return fields;
};

/** Extract the __RequestVerificationToken from HTML. */
const extractAntiforgeryToken = (html: string): string | undefined =>
  extractHiddenField(html, "__RequestVerificationToken");

/**
 * Decode the `\uXXXX` escapes a JavaScript string literal carries.
 *
 * The results page hands its pagination state to `infiniteScroll.js` inside
 * single-quoted literals in which every double quote is escaped. The browser
 * posts the decoded value; anything else posts a query the server does not
 * recognise and answers with an empty body, which reads as a finished day.
 */
const unescapeJsStringLiteral = (value: string): string =>
  value.replace(/\\u(?<hex>[0-9a-fA-F]{4})/gu, (_match, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );

/** Read a `var name = '...';` initializer out of the page's inline script. */
const extractScriptString = (
  html: string,
  name: string,
): string | undefined => {
  const match = new RegExp(
    `var\\s+${name}\\s*=\\s*'(?<value>[^']*)'`,
    "u",
  ).exec(html);
  const value = match?.groups?.["value"];
  return value === undefined ? undefined : unescapeJsStringLiteral(value);
};

/**
 * Everything `/Home/MyResTRowsCont` needs to serve the next page of a search.
 *
 * The field names are the ones `infiniteScroll.js` posts, and the whole query
 * travels in `conditions`: the endpoint reconstructs the search from the body
 * rather than from session state, so a page can be asked for without replaying
 * the search that first produced it.
 */
type ListingContinuation = {
  /** `currParams`: the search conditions, including the date range. */
  conditions: string;
  /** `currViewId`: which result view the rows are rendered in. */
  viewId: string;
  /** `currSort`: the ORDER BY the first page was rendered with. */
  order: string;
};

const extractContinuation = (html: string): ListingContinuation | undefined => {
  const conditions = extractScriptString(html, "currParams");
  const viewId = extractScriptString(html, "currViewId");
  const order = extractScriptString(html, "currSort");
  if (conditions === undefined || viewId === undefined || order === undefined) {
    return undefined;
  }
  return { conditions, viewId, order };
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

/**
 * One row of the portal's own results table.
 *
 * Flat and JSON-serializable on purpose: the reconciliation loop parks a
 * listed item verbatim and replays it into `buildDecision` days later, so
 * anything a row carries has to survive a round trip through JSONB.
 */
export type ParsedRow = {
  /** The docket alone, which is what a citation names and what rows key on. */
  caseNumber: string;
  /**
   * The reference exactly as the portal's citation states it, sheet number
   * included, so the split back into docket and sheet stays reversible from
   * what gets stored.
   *
   * Absent on rows a version of this parser before the sheet was kept parked
   * as JSONB; those replay with no sheet, as they did when they were listed.
   */
  publishedCaseNumber: string | undefined;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  outcome: string | undefined;
  documentUrl: string | undefined;
  /** Numeric document ID for fetching fulltext via /DokumentOriginal/Text/{id}. */
  documentId: string | undefined;
};

/**
 * The publisher's own document id for a row, or undefined where the row states
 * none this store can hold.
 *
 * Stated once, because the crawl, the identity rule and the listing walk must
 * agree exactly on which documents exist. The bound is not decoration: an id
 * past the column's limit is refused by the pipeline's own normalization, so
 * keying a row on it would hunt a row nothing can ever write.
 */
const czNssSourceDocumentId = ({
  documentId,
}: ParsedRow): string | undefined =>
  documentId !== undefined && isPersistableSourceDocumentId(documentId)
    ? documentId
    : undefined;

/** The detail page of one document, which is also the row's stored URL. */
const detailUrl = (documentId: string): string =>
  `${BASE_URL}/DokumentDetail/Index/${documentId}`;

/**
 * Parse result rows from the search response HTML.
 *
 * The 2025 redesign renders results as <tbody> blocks
 * with citation <a title="Citace: ... čj. X"> elements.
 *
 * Exported so the crawl, the listing walk and their tests read one parser:
 * a second copy of these patterns would certify itself rather than the
 * adapter.
 */
export const parseResultRows = (html: string): ParsedRow[] => {
  const rows: ParsedRow[] = [];

  const tbodyPattern = /<tbody>(?<block>[\s\S]*?)<\/tbody>/giu;
  let tbodyMatch: RegExpExecArray | null;

  while ((tbodyMatch = tbodyPattern.exec(html)) !== null) {
    const block = tbodyMatch.groups?.["block"];

    if (!block?.includes("Citace")) {
      continue;
    }

    // č may appear as literal or HTML entity (&#x10D; &#x10d; &#269;)
    // Stop at comma to exclude publication reference (e.g. ", č. 421/2004 Sb. NSS")
    // The sheet number the citation appends is taken by the capture and split
    // off below, not discarded here: dropped at the regex, the sheet is gone
    // from the row and nothing downstream can state where the document sits.
    const citMatch =
      /title="Citace:[^"]*?(?:čj\.|č\.\s*j\.|&#x10[dD];j\.|&#26[89];j\.)[\s]*(?<reference>[^",\s][^",]*?)[",]/iu.exec(
        block,
      );
    const publishedCaseNumber = citMatch?.groups?.["reference"]?.trim();
    if (!publishedCaseNumber || publishedCaseNumber.length > 100) {
      // Skip malformed or overly long case numbers
      if (publishedCaseNumber) {
        logger.warn("case_law.ingestion.malformed_case_number_skipped", {
          adapterKey: ADAPTER_KEYS.CZ_NSS,
          caseNumberLength: publishedCaseNumber.length,
          caseNumberSample: publishedCaseNumber.slice(0, 50),
        });
      }
      continue;
    }
    const { caseNumber } = splitCaseReference(publishedCaseNumber);

    const detailMatch =
      /href="\/DokumentDetail\/Index\/(?<documentId>\d+)"/u.exec(block);
    const documentId = detailMatch?.groups?.["documentId"];
    const documentUrl = documentId ? detailUrl(documentId) : undefined;

    const cells: string[] = [];
    const cellPattern = /<td[^>]*>(?<cell>[\s\S]*?)<\/td>/giu;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(block)) !== null) {
      const cell = cellMatch.groups?.["cell"];
      if (cell) {
        cells.push(stripHtml(cell).trim());
      }
    }

    let decisionDate: string | undefined;
    let decisionType: string | undefined;
    for (const cell of cells) {
      if (!decisionDate && /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/u.test(cell)) {
        decisionDate = cell;
      } else if (
        !decisionType &&
        cell !== caseNumber &&
        cell.length > 2 &&
        cell.length < 50 &&
        !/^\d+$/u.test(cell)
      ) {
        decisionType = cell;
      }
    }

    rows.push({
      caseNumber,
      publishedCaseNumber,
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

const CZ_NSS_REPARSABLE_CONTENT_TYPES = new Set(["text/html"]);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

type CzNssSourceHashOptions = {
  caseNumber: string;
  sheetNumber: string | undefined;
  decisionDate: string | undefined;
  decisionType: string | undefined;
};

/**
 * Stable source-side fields shared by a crawl and a stored-raw replay.
 *
 * The sheet is one of them, and has to be: the refresh check skips a row whose
 * source hash did not move, so a row stored before the sheet was read would
 * see its listing state one and still be skipped, and the sheet would never
 * land. A row gains a sheet exactly when this hash moves.
 *
 * Both halves are normalized to the tight form before hashing, so the same
 * decision hashes the same however it reached us: through a listing that
 * prints `10 A 46/2015-66`, through a legacy row whose case number still
 * carries ` - 66`, or through a court that re-spaces its own citations.
 * Spacing is typography, not a document changing, and a hash that tracked it
 * would rewrite rows for it and would leave crawl and replay disagreeing.
 */
const czNssSourceHash = ({
  caseNumber,
  sheetNumber,
  decisionDate,
  decisionType,
}: CzNssSourceHashOptions): string => {
  const { caseNumber: docket, sheetNumber: carried } =
    splitCaseReference(caseNumber);
  const sheet = sheetNumber ?? carried;
  const reference = sheet === undefined ? docket : `${docket}-${sheet}`;
  return hashContent(
    `${reference}|${decisionDate ?? ""}|${decisionType ?? ""}`,
  );
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
    const response = await fetchWithTimeout(
      `${BASE_URL}/DokumentOriginal/Html/${documentId}`,
      {
        signal,
        headers: {
          ...COMMON_HEADERS,
          Cookie: session.cookies,
        },
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      },
    );

    if (response.ok) {
      const html = await response.text();
      if (html.length > 200 && !html.includes("<body>\n    N/A\n</body>")) {
        const parsed = parseNssDecisionHtml({
          caseNumber: row.caseNumber,
          ecli: detail.ecli,
          court: courtFromEcli(detail.ecli),
          decisionDate: (() => {
            if (detail.decisionDate) {
              return parseCeDate(detail.decisionDate);
            }
            if (row.decisionDate) {
              return parseCeDate(row.decisionDate);
            }
            return undefined;
          })(),
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
    const response = await fetchWithTimeout(
      `${BASE_URL}/DokumentOriginal/Text/${documentId}`,
      {
        signal,
        headers: {
          ...COMMON_HEADERS,
          Cookie: session.cookies,
        },
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
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
  const pattern = new RegExp(`id="${divId}"[^>]*>([\\s\\S]*?)</div>`, "iu");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  // Structure: <span class="det-textitle">Label:</span>
  //            <span class="det-textval" title="Value">Value</span>
  const valPattern =
    /class="det-textval[^"]*"[^>]*>(?<value>[\s\S]*?)<\/span>/giu;
  let valMatch: RegExpExecArray | null;
  const texts: string[] = [];
  while ((valMatch = valPattern.exec(match[1])) !== null) {
    const text = stripHtml(valMatch.groups?.["value"] ?? "").trim();
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

/**
 * The detail page, or the fact that it could not be read.
 *
 * A portal that answers 404 has no metadata for the document, and the row is
 * built without it. A timeout or a server error is not that: the metadata
 * exists and was not read, and a row built from it would carry the fallback
 * court and no ECLI for good, since the refresh hashes only listing fields.
 * Such a row is reported as unavailable, which the reconciliation treats as
 * a document not yet read and comes back for.
 */
type DetailFetch =
  | { type: "fetched"; detail: DetailMetadata }
  | { type: "unavailable" };

const fetchDetailMetadata = async (
  documentId: string,
  session: SessionState,
  signal: AbortSignal,
): Promise<DetailFetch> => {
  try {
    const response = await fetchWithTimeout(
      `${BASE_URL}/DokumentDetail/Index/${documentId}`,
      {
        signal,
        headers: {
          ...COMMON_HEADERS,
          Cookie: session.cookies,
        },
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      },
    );
    if (response.status === 404) {
      return { type: "fetched", detail: EMPTY_DETAIL };
    }
    if (!response.ok) {
      return { type: "unavailable" };
    }

    const html = await response.text();

    return {
      type: "fetched",
      detail: {
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
      },
    };
  } catch {
    return { type: "unavailable" };
  }
};

/** Convert a parsed row into an IngestionResult. */
const rowToResult = (
  row: ParsedRow,
  content: DecisionContent,
  detail: DetailMetadata,
): IngestionResult => {
  const sourceDocumentId = czNssSourceDocumentId(row);
  const court = courtFromEcli(detail.ecli);
  const decisionDate = (() => {
    if (detail.decisionDate) {
      return parseCeDate(detail.decisionDate);
    }
    if (row.decisionDate) {
      return parseCeDate(row.decisionDate);
    }
    return undefined;
  })();
  const decisionType = (detail.decisionType ?? row.decisionType)?.toLowerCase();
  // This source publishes the docket with the sheet number appended.
  const publishedCaseNumber = row.publishedCaseNumber ?? row.caseNumber;
  const { sheetNumber } = splitCaseReference(publishedCaseNumber);

  return {
    caseNumber: row.caseNumber,
    sheetNumber,
    ...(detail.citation === undefined
      ? {}
      : {
          identifiers: [
            {
              type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
              value: detail.citation,
            },
          ],
        }),
    sourceDocumentId,
    // What every row this adapter wrote before it stated an id was stored
    // under: one row per docket, carrying the detail URL of whichever document
    // was written last. The URL names one document exactly, so it re-keys that
    // row to the document it was built from rather than inserting a second one
    // beside it; the other documents the portal files under that docket — a
    // regional court's decision numbered the same, or a further ruling in the
    // same file — find no null-id row and are inserted, which is the collapse
    // being undone.
    ...(sourceDocumentId === undefined
      ? {}
      : { legacySourceUrls: [detailUrl(sourceDocumentId)] }),
    ecli: detail.ecli,
    court,
    country: "CZE",
    language: CZ_NSS_LANGUAGE,
    decisionDate,
    // Prefer structured decisionType from detail page over
    // the heuristic cell match from the search results table
    decisionType,
    fulltext: content.fulltext,
    sourceUrl: row.documentUrl,
    documentUrl: row.documentUrl,
    metadata: {
      caseNumber: row.caseNumber,
      sheetNumber,
      // The reference exactly as the court publishes it, docket and sheet
      // together, so the split stays reversible from what we stored.
      publishedCaseNumber,
      court,
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
    // Fulltext is parser output, not publisher identity. Keeping it out makes
    // crawl and replay converge on the same source hash after parser changes.
    rawHash: czNssSourceHash({
      caseNumber: row.caseNumber,
      sheetNumber,
      decisionDate,
      decisionType,
    }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS],
    documentAst: content.documentAst ?? EMPTY_AST,
    sourceRaw: content.sourceRaw,
    sourceRawContentType: "text/html",
  };
};

/**
 * The reference as published for a stored row, read back from the row itself.
 *
 * Three shapes reach this, and only the first states the reference outright:
 *
 * - Rows written since the sheet was kept carry `publishedCaseNumber`.
 * - Rows written before it carry the reference in `metadata.caseNumber`,
 *   which held whatever the row's case number held at the time. Once the
 *   backfill moves the sheet out of `case_number`, that metadata field is the
 *   only place the published form survives, so a replay that read the column
 *   alone would rebuild the row without it for good.
 * - Rows the backfill has not reached yet still carry the sheet on
 *   `case_number` itself, which splits like any other reference.
 *
 * A candidate is adopted only where it names this row's docket. Metadata is
 * the publisher's, not ours, and a field naming some other case must not
 * become this row's reference. Nothing here reconstructs a reference from the
 * docket and the sheet: the spacing between them is the court's, and inventing
 * one would store a reference no court ever published.
 */
const storedPublishedCaseNumber = ({
  caseNumber,
  metadata,
}: Pick<StoredRawReparseInput, "caseNumber" | "metadata">): string => {
  const docket = splitCaseReference(caseNumber).caseNumber;
  const candidates = [
    nonEmptyString(metadata["publishedCaseNumber"]),
    nonEmptyString(metadata["caseNumber"]),
  ];

  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      splitCaseReference(candidate).caseNumber === docket
    ) {
      return candidate;
    }
  }

  return caseNumber;
};

/** Rebuild one NSS decision from the exact HTML the crawl stored. */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !CZ_NSS_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }

  const html = new TextDecoder().decode(stored.raw);
  const sourceUrl = stored.sourceUrl ?? undefined;
  const decisionDate = stored.decisionDate ?? undefined;
  const decisionType = stored.decisionType ?? undefined;
  const ecli = stored.ecli ?? undefined;
  const parsed = parseNssDecisionHtml({
    caseNumber: stored.caseNumber,
    ecli,
    court: stored.court,
    decisionDate,
    decisionType,
    sourceUrl,
    html,
    detailMetadata: stored.metadata,
  });

  if (parsed.documentAst.blocks.length === 0) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `no blocks parsed from the stored payload for ${stored.caseNumber}`,
    };
  }

  const citation = nonEmptyString(stored.metadata["citation"]);
  const sourceDocumentId = stored.sourceDocumentId ?? undefined;
  const publishedCaseNumber = storedPublishedCaseNumber(stored);
  const { sheetNumber } = splitCaseReference(publishedCaseNumber);

  return {
    type: "parsed",
    result: {
      caseNumber: stored.caseNumber,
      sheetNumber,
      ...(citation === undefined
        ? {}
        : {
            identifiers: [
              {
                type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
                value: citation,
              },
            ],
          }),
      sourceDocumentId,
      ...(sourceDocumentId === undefined
        ? {}
        : { legacySourceUrls: [detailUrl(sourceDocumentId)] }),
      ecli,
      court: stored.court,
      country: "CZE",
      language: stored.language,
      decisionDate,
      decisionType,
      fulltext: parsed.fulltext,
      sourceUrl,
      documentUrl: stored.documentUrl ?? undefined,
      // Written back rather than passed through: a legacy row states the
      // reference only in `metadata.caseNumber`, and a replay that left the
      // metadata as it found it would leave the split unreversible for good.
      // For a row stored since, these are the values already there.
      metadata: { ...stored.metadata, sheetNumber, publishedCaseNumber },
      rawHash: czNssSourceHash({
        caseNumber: stored.caseNumber,
        sheetNumber,
        decisionDate,
        decisionType,
      }),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS],
      documentAst: parsed.documentAst,
      sourceRaw: html,
      sourceRawContentType: "text/html",
    },
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
  const response = await fetchWithTimeout(BASE_URL, {
    signal,
    redirect: "follow",
    headers: COMMON_HEADERS,
    timeoutMs: CZ_NSS_LISTING_TIMEOUT_MS,
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

/** Date field paths in the vyhledavaciSekce form model. */
const DATE_FROM_FIELD =
  "vyhledavaciSekce[1].vyhledavaciPodminka[0]" +
  ".vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd";
const DATE_TO_FIELD =
  "vyhledavaciSekce[1].vyhledavaciPodminka[0]" +
  ".vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo";

/**
 * What one day-filtered search answered with.
 *
 * `statedCount` is the court's own record count for the day and `null` where
 * the page states none — the difference between a day that holds nothing and a
 * page that is not a results page at all.
 */
type SearchResult = {
  html: string;
  continuation: ListingContinuation | undefined;
  statedCount: number | null;
};

/**
 * Execute a search for a specific date by submitting the form to /Home/Index
 * with the date range set to one day. The response carries the first page of
 * results inline, plus the state the remaining pages are requested with.
 */
const executeSearch = async (
  session: SessionState,
  date: string,
  signal: AbortSignal,
): Promise<SearchResult> => {
  const czDate = formatCzDate(parseCursorDate(date));

  const formData = new URLSearchParams();

  for (const [name, value] of session.formFields) {
    formData.set(name, value);
  }

  formData.set("__RequestVerificationToken", session.token);
  formData.set(DATE_FROM_FIELD, czDate);
  formData.set(DATE_TO_FIELD, czDate);

  const response = await fetchWithTimeout(`${BASE_URL}/Home/Index`, {
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
    timeoutMs: CZ_NSS_LISTING_TIMEOUT_MS,
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

  return {
    html,
    continuation: extractContinuation(html),
    statedCount: statedResultCount(html),
  };
};

type FetchResultPageOptions = {
  session: SessionState;
  continuation: ListingContinuation;
  /** The date being searched; error context only. */
  date: string;
  /** 0-indexed page within the day. */
  page: number;
  signal: AbortSignal;
};

/**
 * Fetch one page of results beyond the first, exactly as the portal's own
 * infinite scroll does: the field names, and the whole search query in the
 * body. The endpoint answers a body-only request, so a page is reachable
 * without the session that first ran the search.
 */
const fetchResultPage = async ({
  continuation,
  date,
  page,
  session,
  signal,
}: FetchResultPageOptions): Promise<string> => {
  const formData = new URLSearchParams();
  formData.set("vyhledavaciPodminky", continuation.conditions);
  formData.set("zobrazeniVysledkuId", continuation.viewId);
  formData.set("pageNum", String(page));
  formData.set("resultOrder", continuation.order);

  const response = await fetchWithTimeout(`${BASE_URL}/Home/MyResTRowsCont`, {
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
    timeoutMs: CZ_NSS_LISTING_TIMEOUT_MS,
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

// ── Shared build path ────────────────────────────────────

const EMPTY_CONTENT: DecisionContent = {
  fulltext: undefined,
  documentAst: undefined,
  sourceRaw: undefined,
};

/**
 * What building one listed row produced.
 *
 * `detail-unavailable` still carries the decision the listing alone describes,
 * because the two callers dispose of it differently: the crawl's cursor moves
 * past this document either way, so a listing-only row is worth more to it
 * than nothing, while the reconciliation must refuse it — a detail-less row
 * would make the identity held and take the document out of every later
 * reconciliation.
 */
export type CzNssBuildResult =
  | { type: "built"; decision: IngestionResult }
  | { type: "detail-unavailable"; decision: IngestionResult };

type BuildCzNssDecisionOptions = {
  row: ParsedRow;
  session: SessionState;
  signal: AbortSignal;
};

/**
 * Build one decision from a result row, reading the court's detail page and
 * document for it. Shared by the crawl and the reconciliation walk so neither
 * can parse or enrich a row differently from the other.
 */
export const buildCzNssDecision = async ({
  row,
  session,
  signal,
}: BuildCzNssDecisionOptions): Promise<CzNssBuildResult> => {
  const documentId = czNssSourceDocumentId(row);
  if (documentId === undefined) {
    // The row names no document this adapter can address, so nothing can be
    // read for it — now or on any later attempt. The crawl still stores what
    // the listing states, under the docket alone; the walk counts such a row
    // neither held nor missing, since `czNssListingIdentity` has nothing to
    // key it on.
    return {
      type: "detail-unavailable",
      decision: rowToResult(row, EMPTY_CONTENT, EMPTY_DETAIL),
    };
  }

  const detailFetch = await fetchDetailMetadata(documentId, session, signal);
  if (detailFetch.type === "unavailable") {
    return {
      type: "detail-unavailable",
      decision: rowToResult(row, EMPTY_CONTENT, EMPTY_DETAIL),
    };
  }
  const { detail } = detailFetch;
  const content = await fetchDecisionContent(
    documentId,
    row,
    detail,
    session,
    signal,
  );
  const decision = rowToResult(row, content, detail);

  // Both document endpoints answered with nothing usable. The metadata row is
  // still a decision to the crawl; to the reconciliation it is a document that
  // has not been read yet.
  return content.sourceRaw === undefined && content.fulltext === undefined
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

// ── Reconciliation ───────────────────────────────────────

/**
 * Earliest decision date the portal publishes, and so the oldest slice the
 * historical sweep walks back to.
 *
 * Determined from the source itself rather than from the court's founding
 * date: the NSS took up its work on 1 January 2003, but the portal states no
 * records at all for any range ending 3 February 2003, and four for this day.
 */
export const CZ_NSS_FIRST_SLICE = "2003-02-04";

/**
 * Days near the tip that the reconciliation re-walks on a fast cadence.
 *
 * A slice is the decision date, not the date the portal published it, and the
 * portal posts a decision some time after it is handed down. So the tip window
 * is where the newest dates fill in, and a fortnight keeps the fast lane a
 * fixed, small amount of work.
 *
 * What that does NOT cover, stated plainly rather than assumed away: a
 * decision published more than this window after its decision date lands in a
 * slice the loop has already walked and recorded complete. The ledger's
 * standing re-check only revisits rows recorded short, and the historical
 * sweep only reaches slices never surveyed, so neither returns to it; the
 * crawl cannot either, since its date cursor is forward-only. Closing that
 * needs a bounded periodic resurvey of settled slices in
 * `reconciliation-plan.ts`, which is engine-level and applies to every
 * date-sliced source, not something this adapter can decide for itself.
 * Widening the window here would only move the boundary, not remove it.
 */
const CZ_NSS_TIP_WINDOW_DAYS = 14;

/**
 * Ceiling for one listing request when the loop supplies no signal. The engine
 * always does; this only keeps a direct caller from hanging on the court.
 */
const CZ_NSS_LISTING_TIMEOUT_MS = 60_000;

/**
 * The identity the ingest would store for this listing row.
 *
 * The portal's own `documentId`, taken from the `/DokumentDetail/Index/{id}`
 * link the results table puts on every row — the same id every detail and
 * document request is addressed by, so a row that has one is a document the
 * adapter can both key and read.
 *
 * The docket is not that identity. The portal carries the regional and city
 * administrative courts alongside the NSS, and their dockets are numbered per
 * court, so one `(caseNumber, "cs")` can name decisions of different courts;
 * the sheet number that would separate two rulings in the same file is also
 * dropped from the docket, since a citation names the docket alone. Both
 * collapse several published documents onto one stored row.
 *
 * Rows written before the adapter stated an id are re-keyed by the
 * deterministic `/DokumentDetail/Index/{id}` URL they carry — see
 * `legacySourceUrls` in {@link rowToResult}. The two must state one rule: a
 * walk that keyed rows differently from the ingest would read stored decisions
 * as missing and re-fetch them forever.
 *
 * A row the portal lists without that link is unidentifiable rather than keyed
 * on the docket alone: the ingest cannot read a document for it either, so a
 * slice that counted it would stay short forever.
 */
export const czNssListingIdentity = (row: ParsedRow): ListingIdentity => {
  const sourceDocumentId = czNssSourceDocumentId(row);
  return sourceDocumentId === undefined
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId };
};

/**
 * A reconciliation slice for this source is one UTC decision day, which is
 * exactly what the portal's search is addressed by — the crawl already queries
 * it a day at a time. `YYYY-MM-DD` sorts lexicographically in chronological
 * order, which is the ordering the ledger relies on.
 */
const czNssDaySlices = createCalendarDaySliceWalk({
  firstSlice: CZ_NSS_FIRST_SLICE,
  source: ADAPTER_KEYS.CZ_NSS,
});

/**
 * One page of the portal's own listing for a decision day, with no detail or
 * document fetches.
 *
 * Self-sufficient by construction: it establishes or reuses the session and
 * replays the day's search itself, because the loop calls it one page at a
 * time and carries nothing between the calls.
 *
 * A failed request is thrown, never flattened into an empty page. The crawl
 * can afford to read an unreadable page as "nothing here" because a cursor
 * that moves on can be walked again; a ledger row cannot, since an outage
 * recorded as an empty day makes that day settled and it is never revisited.
 * So only the court's own count answers what a day holds: `Počet nalezených
 * záznamů: 0` is an empty slice, and everything else — a non-2xx, a session
 * page served instead of results, a results page stating no count — is an
 * error the engine retries on a later pass.
 */
const listCzNssSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  // Refuse a slice this adapter cannot have produced before it reaches the
  // date formatter, which would silently query some other day for it.
  czNssDaySlices.dayStart(slice);
  const effectiveSignal =
    signal ?? AbortSignal.timeout(CZ_NSS_LISTING_TIMEOUT_MS);

  const session = await getSession(effectiveSignal);
  const search = await executeSearch(session, slice, effectiveSignal);

  if (search.statedCount === null) {
    // A 200 that is not a results page is what an expired ASP.NET session
    // looks like: the portal re-renders the unsubmitted form. Dropping the
    // session turns one expiry into one failed request instead of ten minutes
    // of them.
    invalidateSession();
    throw new AdapterFetchError({
      message: `NSS stated no result count for ${slice}`,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      cursor: slice,
    });
  }

  const firstPageRows = parseResultRows(search.html);
  if (search.statedCount === 0) {
    if (firstPageRows.length > 0) {
      // The page contradicts itself, so neither number can be trusted for a
      // ledger row. Refused rather than resolved in either direction.
      throw new AdapterFetchError({
        message: `NSS stated no records for ${slice} while rendering ${firstPageRows.length}`,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: slice,
      });
    }
    return { items: [], totalPages: 0 };
  }

  const { continuation } = search;
  if (continuation === undefined) {
    // Same reasoning as the missing count: a results page always carries the
    // state its own infinite scroll pages with, so a page without it is not
    // one the current session produced.
    invalidateSession();
    throw new AdapterFetchError({
      message: `NSS results for ${slice} carried no pagination state`,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      cursor: slice,
    });
  }

  const rows =
    page === 0
      ? firstPageRows
      : parseResultRows(
          await fetchResultPage({
            continuation,
            date: slice,
            page,
            session,
            signal: effectiveSignal,
          }),
        );

  // How many rows this page must carry, from the count the portal stated for
  // the whole day. A short page is refused rather than returned, because the
  // engine measures a slice by the identities the walk produced: a page that
  // quietly came back empty (the continuation endpoint answers 200 with no
  // body when it does not recognise the query) or that a changed table markup
  // parsed only part of would undercount `reported`, and an undercounted
  // `reported` reads as a fully collected day and settles it forever. Left
  // unwritten, the day keeps its previous row and the failure surfaces in the
  // loop's tally.
  const expectedRows = czNssExpectedRows({
    page,
    statedCount: search.statedCount,
  });
  if (rows.length < expectedRows) {
    throw new AdapterFetchError({
      message: `NSS page ${page} of ${slice} carried ${rows.length} of the ${expectedRows} rows its stated count of ${search.statedCount} requires`,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      cursor: slice,
    });
  }

  return {
    items: rows.map((row) => ({
      identity: czNssListingIdentity(row),
      payload: row,
    })),
    totalPages: czNssTotalPages(search.statedCount),
  };
};

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/**
 * Validate a payload the loop stored verbatim.
 *
 * Every field is checked, because the row is this adapter's whole listing
 * observation: a parked payload that no longer matches what the parser
 * produces has to be reported as unbuildable instead of parsed on faith. The
 * optional fields are absent rather than `undefined` after a JSONB round trip,
 * which is what {@link isOptionalString} accepts.
 */
const isCzNssListingRow = (value: unknown): value is ParsedRow =>
  isRecord(value) &&
  typeof value["caseNumber"] === "string" &&
  isOptionalString(value["publishedCaseNumber"]) &&
  isOptionalString(value["decisionDate"]) &&
  isOptionalString(value["decisionType"]) &&
  isOptionalString(value["outcome"]) &&
  isOptionalString(value["documentUrl"]) &&
  isOptionalString(value["documentId"]);

const buildCzNssFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isCzNssListingRow(payload)) {
    return { type: "unkeyable" };
  }
  const effectiveSignal =
    signal ?? AbortSignal.timeout(CZ_NSS_LISTING_TIMEOUT_MS);
  const session = await getSession(effectiveSignal);
  const built = await buildCzNssDecision({
    row: payload,
    session,
    signal: effectiveSignal,
  });
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "detail-unavailable":
      // The decision the listing describes is deliberately dropped: storing it
      // would make the identity held while its document stayed unread.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled NSS build result: ${JSON.stringify(built)}`);
    }
  }
};

/** Parse cursor string "YYYY-MM-DD:page" or null. */
const parseCursor = (cursor: string | null): { date: string; page: number } => {
  if (!cursor) {
    const lookback = addUtcDays(new Date(), -DEFAULT_LOOKBACK_DAYS);
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

export const czNssAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_NSS,
  name: "Czech Supreme Administrative Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 500,
  // Each page = 1 day = session + search + fulltext per decision.
  // With ~20 decisions/day and fulltext fetches, ~30s/page.
  pageTimeoutMs: 120_000,
  maxSyncPages: 20,
  // One stored NSS HTML payload is exactly one decision, so parser upgrades
  // can replay it locally without re-contacting or rate-limiting the court.
  reparseStoredRaw,

  /**
   * The portal aggregates several courts, and its search filters cannot be
   * scoped to one of them without executing the site's own scripts — so the
   * count, like the crawl, covers the portal's whole collection rather than
   * this court alone. The benchmark still matches what the crawl sees.
   */
  async getTotalCount(signal) {
    try {
      const session = await getSession(signal);

      // A search with no criterion silently no-ops (the page re-renders
      // unsubmitted), so an all-inclusive decision-date range supplies the
      // one criterion without excluding anything. Counting the full range
      // is slow on the source's side; the longer timeout is deliberate.
      const formData = new URLSearchParams();
      for (const [name, value] of session.formFields) {
        formData.set(name, value);
      }
      formData.set("__RequestVerificationToken", session.token);
      formData.set(
        "vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd",
        "01.01.1990",
      );
      formData.set(
        "vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo",
        `31.12.${new Date().getFullYear() + 1}`,
      );

      const response = await fetchWithTimeout(`${BASE_URL}/Home/Index`, {
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
        timeoutMs: 90_000,
      });

      if (!response.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }

      // A zero here is not a corpus of nothing; it is a search that did not
      // run, which `sourceTotalRead` refuses along with every other value a
      // total cannot be.
      const count = statedResultCount(await response.text());
      return count === null
        ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
        : sourceTotalRead(count);
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  /**
   * The portal lists each decision day independently of the crawl cursor, so
   * what a day contains is answerable without re-crawling it: enumerate the
   * day, key each row the way the ingest would, and compare against what is
   * held.
   */
  reconciliation: {
    firstSlice: CZ_NSS_FIRST_SLICE,
    ...czNssDaySlices.walk,
    tipWindowDays: CZ_NSS_TIP_WINDOW_DAYS,
    listSlicePage: listCzNssSlicePage,
    buildDecision: buildCzNssFromPayload,
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

        const { continuation } = searchResult;
        if (continuation === undefined || continuation.conditions === "[]") {
          // Not a results page; advance to next day
          const next = nextDay(date);
          return {
            decisions: [],
            nextCursor: next <= today ? `${next}:0` : `${today}:0`,
          };
        }

        // Page 0 results are inline in the search response.
        const html =
          page === 0
            ? searchResult.html
            : await fetchResultPage({
                continuation,
                date,
                page,
                session,
                signal: effectiveSignal,
              });

        const rows = parseResultRows(html);
        const decisions: IngestionResult[] = [];

        for (const row of rows) {
          // oxlint-disable-next-line no-await-in-loop -- sequential per-row crawl against one court session, paced by minRequestIntervalMs
          const built = await buildCzNssDecision({
            row,
            session,
            signal: effectiveSignal,
          });
          // The cursor moves past this document either way, so the crawl keeps
          // the listing-only row an unreadable document still describes; only
          // the reconciliation refuses it.
          decisions.push(built.decision);
        }

        // Determine next cursor. Against the size this page can hold, not the
        // inline one: a continuation page tops out at half of it, so measuring
        // every page against the inline size ended the day at the first
        // continuation page and skipped everything past record 60.
        if (rows.length >= czNssRowsOnPage(page)) {
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
});
