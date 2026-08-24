import { Result, panic } from "better-result";

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
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  isNullishArrayOf,
  isNullishOneOrArrayOf,
  isNullishString,
  isNullishValue,
  parseCeDate,
  stripHtml,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseNsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

const COMMON_HEADERS = {
  "User-Agent": INGESTION_USER_AGENT,
} as const;

/**
 * Czech Supreme Court adapter.
 *
 * The case law database lives on rozhodnuti.nsoud.cz (Lotus
 * Notes/Domino). Uses the ReadViewEntries JSON endpoint for
 * listing decisions, then fetches individual decision pages
 * for metadata (date, ECLI, legal sentence, keywords, etc.).
 *
 * Cursor format: position offset as string (e.g. "1", "21").
 * A null cursor starts from position 1.
 */

const BASE_URL = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";
const PAGE_SIZE = 40;

/** The only language this court publishes. */
const CZ_NS_LANGUAGE = "cs";

/** Domino ReadViewEntries JSON shape. */
type DominoViewEntry = {
  "@position"?: string | null;
  "@unid"?: string | null;
  entrydata?:
    | {
        "@name"?: string | null;
        text?: { "0"?: string | null } | null;
      }[]
    | null;
};

type DominoViewResponse = {
  "@toplevelentries"?: string | null;
  viewentry?: DominoViewEntry | DominoViewEntry[] | null;
};

const isDominoText = (
  value: unknown,
): value is { "0"?: string | null | undefined } =>
  isRecord(value) && isNullishString(value["0"]);

const isDominoEntryData = (
  value: unknown,
): value is {
  "@name"?: string | null;
  text?: { "0"?: string | null } | null;
} =>
  isRecord(value) &&
  isNullishString(value["@name"]) &&
  isNullishValue(value["text"], isDominoText);

const isDominoViewEntry = (value: unknown): value is DominoViewEntry =>
  isRecord(value) &&
  isNullishString(value["@position"]) &&
  isNullishString(value["@unid"]) &&
  isNullishArrayOf(value["entrydata"], isDominoEntryData);

const isDominoViewResponse = (value: unknown): value is DominoViewResponse =>
  isRecord(value) &&
  isNullishString(value["@toplevelentries"]) &&
  isNullishOneOrArrayOf(value["viewentry"], isDominoViewEntry);

const normalizeViewEntries = (
  viewentry: DominoViewResponse["viewentry"],
): DominoViewEntry[] =>
  (() => {
    if (viewentry === undefined || viewentry === null) {
      return [];
    }
    if (Array.isArray(viewentry)) {
      return viewentry;
    }
    return [viewentry];
  })();

/** Extract a named field from Domino entrydata. */
const entryField = (
  entry: DominoViewEntry,
  name: string,
): string | undefined => {
  const field = entry.entrydata?.find((e) => e["@name"] === name);
  return toOptionalValue(field?.text?.["0"]);
};

/** Metadata label patterns on detail pages. */
const LABEL_PATTERNS: Record<string, RegExp> = {
  decisionDate:
    /Datum rozhodnutí:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
  ecli: /ECLI:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
  decisionType:
    /Typ rozhodnutí:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
  keywords:
    /Heslo:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
  statutes:
    /Dotčené předpisy:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
  category:
    /Kategorie rozhodnutí:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
  legalSentence:
    /Právní věta:<\/font><\/b><\/td><td[^>]*>(?<value>[\s\S]*?)<\/td>/iu,
};

/**
 * Extract the presiding judge name from the decision text.
 *
 * NS decisions end with a signature block:
 *   "JUDr. Firstname Surname\npředseda/předsedkyně senátu"
 * We capture the name on the line immediately before the
 * "předseda/předsedkyně senátu" label.
 */
/**
 * Anchor on the label, then read backwards. Leading with the title
 * instead makes the cost quadratic in the length of the decision:
 * every `JUDr.` in the text starts a scan that expands
 * `[\p{L}\s,.-]+?` one character at a time looking for a label that,
 * in a decision that never names a presiding judge, is never there.
 *
 * `kyně` is included because decisions signed by a `předsedkyně
 * senátu` otherwise lose their judge entirely.
 */
const PRESIDING_LABEL_RE = /předsed(?:a|y|kyně)\s+senátu/giu;
const JUDGE_TITLE_RE = /(?:JUDr|Mgr|doc|prof)\./giu;

/** A signature block sits directly above the label. */
const JUDGE_LOOKBACK_CHARS = 200;

/** Guards the window against picking up unrelated preceding text. */
const JUDGE_NAME_RE = /^(?:JUDr|Mgr|doc|prof)\.[\p{L}\s,.-]{1,80}$/u;

const extractJudge = (text: string): string | undefined => {
  // Every label, not just the first. NS decisions routinely open with
  // "složeném z předsedy senátu JUDr. …" and sign off with the real
  // signature block far below; stopping at the first occurrence loses
  // the judge whenever the opening window does not parse as a name.
  for (const label of text.matchAll(PRESIDING_LABEL_RE)) {
    // Trim before windowing: the label is often separated from the
    // signature by a long run of layout whitespace, which would
    // otherwise fill the window and push the name out of it.
    const prefix = text.slice(0, label.index).trimEnd();
    const window = prefix.slice(
      Math.max(0, prefix.length - JUDGE_LOOKBACK_CHARS),
    );

    // Earliest title first, so a stacked one ("doc. JUDr. …") is kept
    // whole. A candidate that fails the name check is skipped rather
    // than returned: the text between it and the label is not a name.
    for (const title of window.matchAll(JUDGE_TITLE_RE)) {
      const name = window.slice(title.index).trim();
      if (JUDGE_NAME_RE.test(name)) {
        return name;
      }
    }
  }

  return undefined;
};

/** Body text markers. */
const BODY_START_MARKERS = [
  "Nejvyšší soud rozhodl",
  "Nejvyšší soud České republiky",
  "Nejvyšší soud projednal",
];
const BODY_END_MARKER = "Citace rozhodnutí";

/** Extract decision fulltext from the detail page body. */
const extractFulltext = (html: string): string | undefined => {
  // Decision text is in <font face="Times New Roman"> tags
  const parts = html.match(
    /<font[^>]*face="Times New Roman"[^>]*>(?:[\s\S]*?)<\/font>/giu,
  );
  if (!parts || parts.length === 0) {
    return undefined;
  }

  let text = stripHtml(parts.join(" ")).trim();

  // Trim metadata prefix — body starts at the decision header
  for (const marker of BODY_START_MARKERS) {
    const pos = text.indexOf(marker);
    if (pos > 0) {
      text = text.slice(pos);
      break;
    }
  }

  // Trim footer
  const endPos = text.indexOf(BODY_END_MARKER);
  if (endPos > 0) {
    text = text.slice(0, endPos).trim();
  }

  return text.length > 100 ? text : undefined;
};

/** Parse metadata from a decision detail page. */
const parseDetailPage = (html: string): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {};

  for (const [key, pattern] of Object.entries(LABEL_PATTERNS)) {
    const match = html.match(pattern);
    if (match?.groups?.["value"]) {
      const text = stripHtml(match.groups["value"]).trim();
      if (text) {
        result[key] = text;
      }
    }
  }

  result["fulltext"] = extractFulltext(html);

  return result;
};

/** One decision as the publisher lists it, whichever listing named it. */
export type CzNsListingRow = {
  /** Domino universal id: the last path segment of the document's own URL. */
  unid: string;
  /** `znacka`, the docket exactly as the publisher writes it. */
  caseNumber: string;
};

/**
 * The two fields a row must state for this adapter to keep it: the docket it
 * is stored under and the universal id its document is keyed on.
 *
 * Stated once, because the crawl, the identity rule and the listing walk must
 * agree exactly on which rows exist — a row one of them keeps and another
 * drops is either a decision nothing ever stores or a slice that can never be
 * filled. The id is bounded here rather than at the pipeline, since it is the
 * stored identity: one the column cannot hold would key a row nothing can
 * write.
 */
const czNsIdentityFields = ({
  caseNumber,
  unid,
}: CzNsListingRow): CzNsListingRow | null =>
  caseNumber.length === 0 || !isPersistableSourceDocumentId(unid)
    ? null
    : { caseNumber, unid };

/**
 * What building one listed decision produced. `detail-unavailable` carries
 * the status the publisher answered with so the crawl can log it; the
 * reconciliation drops it, having only the three outcomes its contract names.
 */
type CzNsBuildResult =
  | { type: "built"; decision: IngestionResult }
  | { type: "unkeyable" }
  | { type: "detail-unavailable"; httpStatus: number };

/**
 * Build one decision from a listed row, through this adapter's own fetch and
 * parse path.
 *
 * The crawl and the reconciliation walk both come through here, so neither
 * can parse a decision the other would parse differently. A detail page that
 * does not come back is reported rather than folded into a decision: the
 * crawl skips such an entry and will meet it again, while a reconciliation
 * that stored the listing alone would make the identity held and take the
 * document out of every later pass.
 *
 * The print page is the AST's source and is treated as enrichment, exactly as
 * the crawl treats it: without it the decision still carries the fulltext and
 * metadata the detail page states, and is stored with an empty AST.
 */
export const buildCzNsDecision = async (
  row: CzNsListingRow,
  signal?: AbortSignal,
): Promise<CzNsBuildResult> => {
  const fields = czNsIdentityFields(row);
  if (fields === null) {
    return { type: "unkeyable" };
  }
  const { caseNumber, unid } = fields;

  const webUrl = `${BASE_URL}/WebSearch/${unid}?openDocument`;
  const printUrl = `${BASE_URL}/WebPrint/${unid}?openDocument`;

  // Detail and print pages in parallel; the pair is one document's worth of
  // work, and the caller paces the requests between documents.
  const [detailResponse, printResponse] = await Promise.all([
    fetchWithTimeout(webUrl, {
      signal,
      headers: COMMON_HEADERS,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    }),
    fetchWithTimeout(printUrl, {
      signal,
      headers: COMMON_HEADERS,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    }),
  ]);

  if (!detailResponse.ok) {
    return { type: "detail-unavailable", httpStatus: detailResponse.status };
  }

  const webHtml = await detailResponse.text();
  const printHtml = printResponse.ok ? await printResponse.text() : "";

  const meta = parseDetailPage(webHtml);
  const raw = `${caseNumber}|${meta["ecli"] ?? ""}|${meta["decisionDate"] ?? ""}`;

  // Parse AST from the print page (rich HTML)
  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let fulltext = meta["fulltext"];

  let sourceMetadata: Record<string, unknown> = {};

  if (printHtml) {
    const parsed = parseNsDecisionHtml({
      documentId: unid,
      webUrl,
      printUrl,
      webHtml,
      printHtml,
    });
    documentAst = parsed.documentAst;
    fulltext = parsed.fulltext;
    sourceMetadata = parsed.sourceMetadata;
  }

  // Extract judge from fulltext signature block
  const judge = fulltext ? extractJudge(fulltext) : undefined;

  return {
    type: "built",
    decision: {
      caseNumber,
      sourceDocumentId: unid,
      // What every row this adapter wrote before it stated an id was stored
      // under: one row per docket, carrying the document URL of whichever of
      // the docket's decisions was written last. The URL names one document
      // exactly, so it re-keys that row to the document it was built from
      // rather than inserting a second one beside it; the docket's further
      // decisions find no null-id row and are inserted, which is the collapse
      // being undone.
      legacySourceUrls: [webUrl],
      ecli: meta["ecli"],
      court: "Nejvyšší soud",
      country: "CZE",
      language: CZ_NS_LANGUAGE,
      decisionDate: meta["decisionDate"]
        ? parseCeDate(meta["decisionDate"])
        : undefined,
      decisionType: meta["decisionType"]?.toLowerCase(),
      fulltext,
      sourceUrl: webUrl,
      documentUrl: webUrl,
      metadata: {
        caseNumber,
        ecli: meta["ecli"],
        court: "Nejvyšší soud" as const,
        decisionDate: meta["decisionDate"]
          ? parseCeDate(meta["decisionDate"])
          : undefined,
        decisionType: meta["decisionType"]?.toLowerCase(),
        ...sourceMetadata,
        judge,
        legalSentence: meta["legalSentence"],
        keywords: meta["keywords"]?.split("\n").flatMap((s) => {
          const trimmed = s.trim();
          return trimmed ? [trimmed] : [];
        }),
        statutes: meta["statutes"]?.split("\n").flatMap((s) => {
          const trimmed = s.trim();
          return trimmed ? [trimmed] : [];
        }),
        category: meta["category"]?.trim(),
      },
      rawHash: hashContent(raw),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS],
      documentAst,
      sourceRaw: JSON.stringify({ webHtml, printHtml }),
      sourceRawContentType: "text/html",
    },
  };
};

// -- Reconciliation --
//
// The view the crawl walks is sorted by universal id, and a universal id says
// nothing about when its document appeared. So a position in that view is not
// a slice: insert one decision and every `Start=N` after it names a different
// document, which would have a reconciliation double-count and miss in the
// same pass. It is also why the crawl needs reconciling at all — parking its
// cursor near the end of an id-ordered view leaves it watching a stretch of
// the alphabet, not the newest decisions.
//
// The court's own search surface answers a date range instead, and a date
// range is the same question however often it is asked. A slice is therefore
// one UTC day of `datum_predani_na_web`, the day the publisher handed the
// document to the web: `YYYY-MM-DD` sorts lexicographically in chronological
// order, and a past day is closed, since a document published later carries
// the later date. Decision date would have been the more evenly filled axis
// and the wrong one: a 2015 decision first published today would land in a
// 2015 slice the sweep had already settled.

/** The search view, which the publisher's own date filter is addressed to. */
const SEARCH_URL = `${BASE_URL}/$$WebSearch1`;

/** Full-text field holding the day a document was handed to the web. */
const PUBLICATION_DATE_FIELD = "datum_predani_na_web";

/**
 * Results one search can address. The publisher states the ceiling itself
 * ("z 900 zobrazovaných dokumentů", printed alongside the true match count
 * whenever the two differ) and it does not move: `SearchMax` of 300, 1000,
 * 2000 and 5000 all answer 900. Rows past it are not served at all — `Start`
 * of 5001 into a 50,454-result query answers with an empty table rather than
 * the 5001st row — so a slice is asked for in a single request of this size,
 * and a day that does not fit in the window is refused rather than truncated.
 */
const CZ_NS_LISTING_WINDOW = 900;

/**
 * Sent because the publisher's own form sends it and rejects a small value
 * (`SearchMax=1` answers 500), not because it bounds anything: the window
 * above is the publisher's and no value here raises or lowers it.
 */
const SEARCH_MAX = 1000;

/** Keep the view's own order, so one slice's rows come back in a fixed one. */
const SEARCH_ORDER_VIEW = 4;

/**
 * First publication day the search surface can enumerate.
 *
 * The publisher stamped its entire legacy archive with a single publication
 * date when it went online: 2009-12-31 answers with 50,454 documents, 31% of
 * the 164,389 the view holds, against a window that addresses 900. That day
 * is not listable, and no sub-range of it is either — the field the search
 * offers alongside it, the decision date, spreads those documents over some
 * two hundred and forty months, which is past the walk's own page ceiling.
 * The sweep is bounded to the era where the publication date is the date a
 * document actually appeared, which begins the day after. The archive below
 * it is what the crawl's full walk of the id-ordered view already covers;
 * what that walk cannot see, and this capability exists for, is the tip.
 */
export const CZ_NS_FIRST_SLICE = "2010-01-01";

/**
 * Days near the tip that the reconciliation re-walks on a fast cadence. The
 * court publishes on working days, so a fortnight is around ten days that
 * carry anything, and covers a long weekend plus a public holiday without
 * the fast lane growing.
 */
const CZ_NS_TIP_WINDOW_DAYS = 14;

const czNsDaySlices = createCalendarDaySliceWalk({
  firstSlice: CZ_NS_FIRST_SLICE,
  source: ADAPTER_KEYS.CZ_NS,
});

/** The publisher's own date literal for a slice: `DD.MM.YYYY`. */
const czNsSliceDate = (slice: string): string => {
  const start = czNsDaySlices.dayStart(slice);
  const day = String(start.getUTCDate()).padStart(2, "0");
  const month = String(start.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${String(start.getUTCFullYear()).padStart(4, "0")}`;
};

/**
 * A result row. The docket and the universal id come out of the same anchor,
 * so a row that names one names the other, and a row that names neither is
 * not a row at all.
 *
 * The docket runs to the anchor's close rather than to the first tag inside
 * it: one decision can settle several dockets, and the publisher prints those
 * inside the one anchor separated by `<br />`. A group that stopped at markup
 * skipped such a row entirely, and the day it fell in then counted one more
 * decision than it listed and could never settle.
 */
const LISTING_ROW_PATTERN =
  /<a\s+class="odk"\s+href="[^"]*\/WebSearch\/(?<unid>[0-9A-Fa-f]{32})\?openDocument"[^>]*>(?<caseNumber>[\s\S]*?)<\/a>/gu;

/** What several dockets settled by one decision are joined with. */
const CASE_NUMBER_SEPARATOR = ", ";

/**
 * The docket an anchor names, as one field.
 *
 * `stripHtml` turns the publisher's `<br />` between co-settled dockets into
 * a line break; the store holds one case number per decision, so the parts
 * are joined into a single number. Identity is unaffected: this adapter keys
 * a decision on its universal id, and the docket is descriptive.
 */
const parseListingCaseNumber = (raw: string): string =>
  stripHtml(raw)
    .split("\n")
    .flatMap((part) => {
      const trimmed = part.trim();
      return trimmed.length === 0 ? [] : [trimmed];
    })
    .join(CASE_NUMBER_SEPARATOR);

/**
 * The two counts the publisher may state about a listing, both captured under
 * one group name so that reading either is the same operation.
 */
const LISTING_COUNT_PATTERN = {
  /** "Výsledky 1 - 23 z 23 zobrazovaných dokumentů." Absent for a lone hit. */
  SHOWN: /Výsledky\s+\d+\s*-\s*\d+\s+z\s+(?<count>\d+)\s+zobrazovaných/u,
  /** "(Podmínce vyhovuje: 50454 )", printed only when the window truncated. */
  MATCHED: /Podmínce vyhovuje:\s*(?<count>\d+)/u,
} as const;

/** The publisher's own words for a day it published nothing on. */
const LISTING_EMPTY_MARKER = "Nebyly nalezeny žádné výsledky vyhledávání";

const parseListingCount = (
  html: string,
  pattern: RegExp,
): number | undefined => {
  const raw = pattern.exec(html)?.groups?.["count"];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const parseListingRows = (html: string): CzNsListingRow[] =>
  [...html.matchAll(LISTING_ROW_PATTERN)].map((match) => ({
    unid: match.groups?.["unid"] ?? "",
    caseNumber: parseListingCaseNumber(match.groups?.["caseNumber"] ?? ""),
  }));

/**
 * The identity the ingest would store for a listed row.
 *
 * The Domino universal id, which is stable and unique per document and is
 * what {@link buildCzNsDecision} now stores as `sourceDocumentId`. The docket
 * is not: the court publishes a docket's further decisions under the same
 * `znacka`, sometimes distinguished only by a suffix it writes into the number
 * itself ("21 Cdo 288/2026- III.") and often not at all, so a
 * `(caseNumber, language)` key names a docket rather than a document and
 * collapses those rows into one.
 *
 * Rows written before the adapter stated an id are re-keyed by the
 * deterministic `WebSearch/{unid}` URL they carry — see `legacySourceUrls` in
 * the build. The two must state one rule: a walk that keyed rows differently
 * from the ingest would read stored decisions as missing and re-fetch them
 * forever.
 *
 * A row missing either half is unidentifiable rather than keyed on what is
 * left: the crawl drops such an entry, so a slice that counted it would stay
 * short forever.
 */
export const czNsListingIdentity = (row: CzNsListingRow): ListingIdentity => {
  const fields = czNsIdentityFields(row);
  return fields === null
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId: fields.unid };
};

/**
 * One publication day, in one request.
 *
 * There is no paging within a slice, and that is the point: the publisher
 * pages this listing positionally, so a document arriving between two page
 * requests would shift every row after it and have the walk count one twice
 * and never see another. A day is asked for whole, inside the window the
 * publisher will address, or not at all.
 *
 * Only a body that states its own outcome is an answer. The publisher says
 * "Nebyly nalezeny žádné výsledky vyhledávání" for a day it published nothing
 * on, and that is the empty slice. Everything else — a non-2xx, a body with
 * neither rows nor that sentence, a body whose stated counts disagree with
 * the rows it carries, a day larger than the window — is thrown, because a
 * short listing banked as a whole slice records `reported` below the truth
 * and reads ever after as fully collected.
 */
const listCzNsSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  if (page !== 0) {
    panic(`cz-ns slice page out of range: ${page}`);
  }

  const date = czNsSliceDate(slice);
  const query =
    `[${PUBLICATION_DATE_FIELD}]>=${date} AND ` +
    `[${PUBLICATION_DATE_FIELD}]<=${date}`;
  const url =
    `${SEARCH_URL}?SearchView&Query=${encodeURIComponent(query)}` +
    `&SearchMax=${SEARCH_MAX}` +
    `&SearchOrder=${SEARCH_ORDER_VIEW}` +
    `&Start=1&Count=${CZ_NS_LISTING_WINDOW}`;

  const response = await fetchWithTimeout(url, {
    signal,
    headers: COMMON_HEADERS,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (!response.ok) {
    throw new AdapterFetchError({
      message: `CZ Supreme Court listing error: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      cursor: slice,
      httpStatus: response.status,
    });
  }

  const html = await response.text();
  const rows = parseListingRows(html);

  if (rows.length === 0) {
    if (html.includes(LISTING_EMPTY_MARKER)) {
      return { items: [], totalPages: 0 };
    }
    throw new AdapterFetchError({
      message: `CZ Supreme Court listing for ${slice} stated neither results nor emptiness`,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      cursor: slice,
    });
  }

  // This count is the day's true size, printed only when it exceeds what the
  // publisher will serve. Any disagreement with the rows carried is refused,
  // in both directions: above, the window truncated the day; below, the body
  // contradicts itself and its rows are not the day it counted. Neither is a
  // listing this walk may bank as a whole slice.
  const matched = parseListingCount(html, LISTING_COUNT_PATTERN.MATCHED);
  if (matched !== undefined && matched !== rows.length) {
    throw new AdapterFetchError({
      message: `CZ Supreme Court listing for ${slice} counts ${matched} decisions and carries ${rows.length}, against the ${CZ_NS_LISTING_WINDOW} one search addresses`,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      cursor: slice,
    });
  }

  // The publisher counts the rows it is about to print, so its number and the
  // rows parsed out of the same body have to agree. Where they do not, the
  // listing is not the one this parser reads and its shortfall is not a fact
  // about the day. It omits the count for a lone hit and only for a lone hit,
  // so several rows under no count are the same disagreement stated by
  // absence — which is how a change to this markup surfaces as an error
  // rather than as a day that quietly lost most of its decisions.
  const shown = parseListingCount(html, LISTING_COUNT_PATTERN.SHOWN);
  if (shown === undefined ? rows.length > 1 : shown !== rows.length) {
    throw new AdapterFetchError({
      message: `CZ Supreme Court listing for ${slice} states ${shown ?? "no"} decisions and carries ${rows.length}`,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      cursor: slice,
    });
  }

  if (rows.length >= CZ_NS_LISTING_WINDOW) {
    throw new AdapterFetchError({
      message: `CZ Supreme Court listing for ${slice} filled the ${CZ_NS_LISTING_WINDOW} a search addresses`,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      cursor: slice,
    });
  }

  return {
    items: rows.map((row) => ({
      identity: czNsListingIdentity(row),
      payload: row,
    })),
    totalPages: 1,
  };
};

const isCzNsListingRow = (value: unknown): value is CzNsListingRow =>
  isRecord(value) &&
  typeof value["unid"] === "string" &&
  typeof value["caseNumber"] === "string";

/**
 * Rebuild a decision from a row the loop stored verbatim. The payload is
 * revalidated rather than trusted: it may have been parked for days, and a
 * shape this adapter no longer recognises has to be reported as unbuildable
 * instead of parsed on faith.
 */
const buildCzNsFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isCzNsListingRow(payload)) {
    return { type: "unkeyable" };
  }
  const built = await buildCzNsDecision(payload, signal);
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    case "detail-unavailable":
      // The status the crawl logs is dropped, not the distinction: the loop
      // parks this item and widens its schedule, and never writes a row that
      // would make the identity held while its document stayed unread.
      return { type: "detail-unavailable" };
    default: {
      const exhaustive: never = built;
      return panic(
        `Unhandled cz-ns build result: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
};

export const czNsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_NS,
  name: "Czech Supreme Court",
  country: "CZE",
  language: CZ_NS_LANGUAGE,
  minRequestIntervalMs: 200,
  // Each page fetches 40 decisions + detail pages. ~40s/page.
  // 15 pages ≈ 10 min (within MAX_CYCLE_MS).
  maxSyncPages: 15,

  /**
   * The publisher lists a publication day independently of the crawl cursor,
   * so what a day contains is answerable without walking the id-ordered view
   * to it: enumerate the day, key each row the way the ingest would, and
   * compare against what is held.
   */
  reconciliation: {
    firstSlice: CZ_NS_FIRST_SLICE,
    ...czNsDaySlices.walk,
    tipWindowDays: CZ_NS_TIP_WINDOW_DAYS,
    listSlicePage: listCzNsSlicePage,
    buildDecision: buildCzNsFromPayload,
  },

  async getTotalCount(signal) {
    try {
      const url =
        `${BASE_URL}/WebSearch?ReadViewEntries` +
        `&Count=1&Start=1&OutputFormat=JSON`;

      const response = await fetchWithTimeout(url, {
        signal,
        headers: COMMON_HEADERS,
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      });
      if (!response.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }

      const json = await response.json();
      if (!isDominoViewResponse(json)) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      const raw = json["@toplevelentries"];
      if (!raw) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }

      return sourceTotalRead(Number.parseInt(raw, 10));
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const start = cursor ? Number.parseInt(cursor, 10) : 1;

        const listUrl =
          `${BASE_URL}/WebSearch?ReadViewEntries` +
          `&Count=${PAGE_SIZE}` +
          `&Start=${start}` +
          `&OutputFormat=JSON`;

        const listResponse = await fetchWithTimeout(listUrl, {
          headers: COMMON_HEADERS,
          signal,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        });

        if (!listResponse.ok) {
          throw new AdapterFetchError({
            message: `CZ Supreme Court list error: ${listResponse.status}`,
            adapterKey: ADAPTER_KEYS.CZ_NS,
            cursor,
            httpStatus: listResponse.status,
          });
        }

        const json = await listResponse.json();
        if (!isDominoViewResponse(json)) {
          throw new AdapterFetchError({
            message: "CZ Supreme Court list returned an invalid payload",
            adapterKey: ADAPTER_KEYS.CZ_NS,
            cursor,
          });
        }
        const entries = normalizeViewEntries(json.viewentry);

        const decisions: IngestionResult[] = [];

        for (let i = 0; i < entries.length; i++) {
          const entry = entries.at(i);
          if (!entry) {
            continue;
          }
          const unid = entry["@unid"] ?? "";
          const caseNumber = entryField(entry, "znacka") ?? "";

          try {
            // oxlint-disable-next-line no-await-in-loop -- polite sequential crawl of one court detail page per entry, rate-limited via Bun.sleep below
            const built = await buildCzNsDecision({ caseNumber, unid }, signal);

            switch (built.type) {
              case "built": {
                decisions.push(built.decision);
                break;
              }
              case "detail-unavailable": {
                logger.warn("case_law.ingestion.detail_fetch_failed", {
                  adapterKey: ADAPTER_KEYS.CZ_NS,
                  documentId: unid,
                  httpStatus: built.httpStatus,
                });
                break;
              }
              case "unkeyable": {
                // The view entry names no document or no docket: there is
                // nothing to fetch and nothing the pipeline could key.
                break;
              }
              default: {
                const exhaustive: never = built;
                return panic(
                  `Unhandled cz-ns build result: ${JSON.stringify(exhaustive)}`,
                );
              }
            }
          } catch (error) {
            // Caller cancelled: return partial results
            if (error instanceof DOMException && error.name === "AbortError") {
              return {
                decisions,
                nextCursor: String(start + i),
              };
            }
            // Timeout: distinguish page-level from per-entry
            if (
              error instanceof DOMException &&
              error.name === "TimeoutError"
            ) {
              // Page-level signal fired: return partial results
              if (signal?.aborted) {
                return {
                  decisions,
                  nextCursor: String(start + i),
                };
              }
              // Per-entry timeout: skip this entry
              continue;
            }
            throw error;
          }

          // Rate limit between detail fetches (skip for last entry)
          if (i < entries.length - 1) {
            // oxlint-disable-next-line no-await-in-loop -- deliberate crawl delay between sequential court detail fetches
            await Bun.sleep(50);
          }
        }

        const totalEntries = json["@toplevelentries"]
          ? Number.parseInt(json["@toplevelentries"], 10)
          : undefined;

        const hasMore =
          totalEntries !== undefined
            ? start + entries.length <= totalEntries
            : entries.length >= PAGE_SIZE;

        // When exhausted, park the cursor one page back from the
        // end so the next cycle only re-checks recent entries for
        // new additions. Never return null — that restarts the
        // full scan from position 1.
        const nextCursor = hasMore
          ? String(start + entries.length)
          : String(Math.max(1, start + entries.length - PAGE_SIZE));

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_NS, cursor),
    });
  },
});
