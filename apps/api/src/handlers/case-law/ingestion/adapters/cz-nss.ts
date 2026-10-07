// parser-output-unchanged: Bounded crawl retries and cursor encoding change fetch control without changing parsed decision output.
// parser-output-unchanged: fetch-stage telemetry and document-stage metadata only; parser decision fields are unchanged.
// parser-output-unchanged: Reconciliation revision projections classify listing inputs without changing parsed decision output.
import { panic, Result } from "better-result";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_FIELD_KEYS,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { classifyFailure } from "@stll/errors";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { Temporal } from "@stll/time";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import {
  backlogSurface,
  decodeSourceRawEnvelope,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import {
  readBodyText,
  readPublisher,
  readPublisherBytes,
  readPublisherText,
  unreadPublisherError,
  type UnreadPublisherOutcome,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { czechReporterIdentifiersFromCitationLabel } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { czDecisionCourt } from "@/api/lib/case-law/cz-ecli-courts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  checkedDecisionMetadata,
  sourceTextField,
  splitStoredDecisionTextMetadata,
} from "@/api/lib/case-law/decision-text";
import { isDocketShapedDecisionType } from "@/api/lib/case-law/decision-type-key";
import { PlainTextError } from "@/api/lib/case-law/plain-text";
import { addUtcDays } from "@/api/lib/dates";
import {
  READ_OUTCOME_METADATA_KEY,
  readAbsent,
  storedReadUnavailable,
  type ReadOutcome,
  type StoredReadOutcome,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
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
 * Cursor format: "YYYY-MM-DD:page" where page is 0-indexed; JSON when
 * checkpointing count retries or the earliest unsettled day.
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
 * ECLI does, in its court code, so `czDecisionCourt` reads it from there and
 * this label covers only documents that carry no ECLI.
 */
const CZ_NSS_COURT = "Nejvyšší správní soud";

const nssReporterIdentifiers = (citation: string | undefined) =>
  citation === undefined
    ? undefined
    : (czechReporterIdentifiersFromCitationLabel(citation) ?? undefined);

/** The deciding court this portal states for one decision. */
const czNssCourt = (
  ecli: string | undefined,
  sourceDocumentId: string | undefined,
): string =>
  czDecisionCourt({
    adapterKey: ADAPTER_KEYS.CZ_NSS,
    ecli,
    publisherCourt: CZ_NSS_COURT,
    sourceDocumentId,
  });

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

/** The four hex digits a `\uXXXX` escape is made of. */
const HEX_QUAD_PATTERN = /^[0-9a-fA-F]{4}$/u;

/** The single-character escapes a JavaScript string literal may carry. */
const SINGLE_CHARACTER_ESCAPES = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
]);

/**
 * Decode a JavaScript string literal the way the interpreter reads it.
 *
 * The results page hands its pagination state to `infiniteScroll.js` inside
 * single-quoted literals in which every double quote is escaped. The browser
 * posts the decoded value; anything else posts a query the server does not
 * recognise and answers with an empty body.
 *
 * The escapes have to be consumed left to right, the backslash first. A
 * reader that resolved `\uXXXX` wherever it appeared would treat the second
 * half of an escaped backslash as the start of an escape, and any condition
 * whose value is itself quoted JSON carries one: a codelist condition states
 * its options in `ciselnikTreeData`, whose titles are wrapped in `\\` plus
 * the escape for a double quote. The date-range search the crawl runs has no
 * such condition, which is why the simpler reader stood; a single codelist
 * condition decodes into text that is no longer JSON.
 */
const unescapeJsStringLiteral = (value: string): string => {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = value[index + 1];
    index += 1;
    if (escape === "u") {
      const hex = value.slice(index + 1, index + 5);
      if (HEX_QUAD_PATTERN.test(hex)) {
        decoded += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 4;
        continue;
      }
    }
    // `\\`, `\'`, `\"` and anything else stand for the character they escape;
    // a backslash ending the literal stands for itself.
    decoded +=
      escape === undefined
        ? "\\"
        : (SINGLE_CHARACTER_ESCAPES.get(escape) ?? escape);
  }
  return decoded;
};

/**
 * Read a `var name = '...';` initializer out of the page's inline script.
 *
 * The literal ends at the first *unescaped* quote. Ending it at any quote
 * would truncate a value containing an escaped apostrophe and post a prefix
 * of the query, which the endpoint does not recognise.
 */
const extractScriptString = (
  html: string,
  name: string,
): string | undefined => {
  const match = new RegExp(
    `var\\s+${name}\\s*=\\s*'(?<value>(?:\\\\.|[^'\\\\])*)'`,
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

/** Format a calendar date for the NSS search form. */
const formatCzDate = (date: Temporal.PlainDate): string => {
  const day = String(date.day).padStart(2, "0");
  const month = String(date.month).padStart(2, "0");
  return `${day}.${month}.${date.year}`;
};

const parseCursorDate = (date: string) => Temporal.PlainDate.from(date);

const nextDay = (date: string): string =>
  parseCursorDate(date).add({ days: 1 }).toString();

/** Today's date as YYYY-MM-DD. */
const todayIso = (): string => {
  const iso = Temporal.Now.instant()
    .toString({ fractionalSecondDigits: 3 })
    .split("T")[0];
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
   * The reference as the portal's visible results cell states it, decoded and
   * with HTML whitespace normalized. The sheet number stays included so the
   * split back into docket and sheet is reversible from what gets stored.
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

/** Stable columns in one row of the publisher's results table. */
const CZ_NSS_RESULT_CELL = {
  CASE_REFERENCE: 3,
  DECISION_DATE: 2,
  DECISION_TYPE: 5,
} as const;

const CZ_NSS_CASE_REFERENCE_MAX_LENGTH = 100;
const CZ_NSS_DECISION_TYPE_MAX_LENGTH = 50;

/**
 * A type the page states, or nothing when the field holds a docket number:
 * some rows carry a reference where the type belongs, and storing it made a
 * case number a decision type. Applied to the listing cell and the detail
 * field alike, since either may win.
 */
const statedDecisionType = (value: string | undefined): string | undefined =>
  value === undefined || isDocketShapedDecisionType(value) ? undefined : value;

/**
 * Parse result rows from the search response HTML.
 *
 * The 2025 redesign renders results as one <tbody> block per decision. The
 * reference is a visible table cell; the neighbouring citation/copy action is
 * optional and therefore cannot decide whether the row exists.
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
    if (block === undefined) {
      continue;
    }

    const detailMatch =
      /href="\/DokumentDetail\/Index\/(?<documentId>\d+)"/u.exec(block);
    const documentId = detailMatch?.groups?.["documentId"];
    if (
      documentId === undefined ||
      !isPersistableSourceDocumentId(documentId)
    ) {
      continue;
    }

    const cells: string[] = [];
    const cellPattern = /<td[^>]*>(?<cell>[\s\S]*?)<\/td>/giu;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(block)) !== null) {
      cells.push(
        stripHtml(cellMatch.groups?.["cell"] ?? "")
          .replace(/\s+/gu, " ")
          .trim(),
      );
    }

    const publishedCaseNumber = cells.at(CZ_NSS_RESULT_CELL.CASE_REFERENCE);
    if (
      !publishedCaseNumber ||
      publishedCaseNumber.length > CZ_NSS_CASE_REFERENCE_MAX_LENGTH
    ) {
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
    const documentUrl = detailUrl(documentId);

    const dateCell = cells.at(CZ_NSS_RESULT_CELL.DECISION_DATE);
    const decisionDate =
      dateCell !== undefined && /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/u.test(dateCell)
        ? dateCell
        : undefined;
    const decisionTypeCell = cells.at(CZ_NSS_RESULT_CELL.DECISION_TYPE);
    const decisionType =
      decisionTypeCell !== undefined &&
      decisionTypeCell.length > 2 &&
      decisionTypeCell.length < CZ_NSS_DECISION_TYPE_MAX_LENGTH
        ? statedDecisionType(decisionTypeCell)
        : undefined;

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
  /** The rich HTML document, which is what the parser reads. */
  sourceRaw: string | undefined;
  /**
   * The plain-text document, where the portal served that endpoint and not the
   * rich one. Kept because it is a response fetched for this decision: a row
   * built from it carries fulltext and no AST, and dropping the payload would
   * leave that row with nothing to re-read.
   */
  fallbackText: string | undefined;
};

/**
 * The pages fetched for one decision, as the stored raw names them. A row
 * written before the envelope holds the document alone, as bare HTML.
 *
 * The listing is the results-table row the crawl read the decision from: the
 * docket with its sheet, and the date, type and outcome the detail page may
 * not state. It is stored so the fingerprint covers every input the row is
 * built from.
 */
const CZ_NSS_RAW_PART = {
  DOCUMENT: "document",
  DETAIL: "detail",
  TEXT: "text",
  LISTING: "listing",
} as const;

type CzNssRawPart = (typeof CZ_NSS_RAW_PART)[keyof typeof CZ_NSS_RAW_PART];

/**
 * A read of the portal that failed: it did not answer, or not in time. Graded
 * as the publisher being unavailable, since the document is read again on a
 * later pass.
 */
const publisherReadFailure = (error: unknown): object =>
  classifyFailure(
    typeof error === "object" && error !== null
      ? error
      : new Error("NSS publisher read failed", { cause: error }),
    "upstream_unavailable",
  );

/** The detail-page parser threw on a page the portal served. */
const detailParseFailed = failureSink({
  event: "case_law.ingestion.detail_parse_failed",
  expected: [],
});

const detailReadFailed = failureSink({
  event: "case_law.ingestion.detail_fetch_failed",
  expected: [],
});

/** A document endpoint's read failed; `phase` names which one. */
const documentReadFailed = failureSink({
  event: "case_law.ingestion.document_fetch_failed",
  expected: [],
});

/** The parser threw on a rich document the portal served. */
const documentParseFailed = failureSink({
  event: "case_law.ingestion.document_parse_failed",
  expected: [],
});

/**
 * Shortest plain-text payload this adapter reads as a document. Below it the
 * endpoint answered with a portal notice rather than a decision, and the crawl
 * and the replay have to draw that line in the same place.
 */
const CZ_NSS_MIN_FULLTEXT_CHARS = 100;

const CZ_NSS_REPARSABLE_CONTENT_TYPES = new Set([
  "text/html",
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
]);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * A read that established nothing about a document the portal lists: refused
 * or failed. A 404 or 410 is not one; it states the portal holds nothing.
 */
type UnreadNssRead = Exclude<UnreadPublisherOutcome, { type: "absent" }>;

/**
 * The typed outcome a row held listing-only for an unread document carries,
 * re-checked on the normal cadence. The adapter sees one cycle; counting
 * consecutive ones is the pipeline's.
 */
const storedDocumentReadOutcome = (read: UnreadNssRead): StoredReadOutcome =>
  read.type === "refused"
    ? read
    : storedReadUnavailable({
        cause: read.cause,
        scope: "document",
        consecutiveCycles: 1,
      });

/**
 * The document's content, or the fact that a document read failed. A held
 * row states the outcome of the read that failed where one did; a parser's
 * failure states none.
 */
type DecisionContentRead =
  | { type: "read"; content: DecisionContent }
  | { type: "unavailable"; readOutcome: StoredReadOutcome | null };

type ObserveDocumentReadFailedOptions = {
  documentId: string;
  phase: CzNssRawPart;
  read: UnreadNssRead;
};

/**
 * A document endpoint's read failed or was refused; reported (a refusal with
 * its typed `ReadRefusal`), and the row is held unread with the outcome.
 */
const observeDocumentReadFailed = ({
  documentId,
  phase,
  read,
}: ObserveDocumentReadFailedOptions): DecisionContentRead => {
  observeFailure(
    publisherReadFailure(
      unreadPublisherError({
        outcome: read,
        message: `NSS ${phase} read failed`,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: null,
      }),
    ),
    {
      sink: documentReadFailed,
      ctx: { adapterKey: ADAPTER_KEYS.CZ_NSS, documentId, phase },
    },
  );
  return { type: "unavailable", readOutcome: storedDocumentReadOutcome(read) };
};

/**
 * The placeholder page the portal serves for a document it holds no rich
 * original of.
 */
const isRichDocumentPlaceholder = (html: string): boolean =>
  html.length <= 200 || html.includes("<body>\n    N/A\n</body>");

/**
 * Read the rich HTML from /DokumentOriginal/Html/{id}.
 *
 * Absent where the portal answers 404 or 410, or serves its placeholder page:
 * it holds no rich original, and the plain-text endpoint is read instead. A
 * failed read is not that absence. A read the page's signal aborts goes back
 * to the crawl, which disposes of the row together with the rest of its page.
 */
const fetchRichDocument = async (
  documentId: string,
  session: SessionState,
  signal: AbortSignal,
): Promise<ReadOutcome<string>> => {
  const read = await readPublisherText(
    `${BASE_URL}/DokumentOriginal/Html/${documentId}`,
    {
      fetchStage: "document",
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      signal,
      headers: {
        ...COMMON_HEADERS,
        Cookie: session.cookies,
      },
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      // The AST's source: a refusal withholds the document, and the text
      // endpoint is never read in its place.
      refusalScope: "document",
    },
  );
  return read.type === "present" && isRichDocumentPlaceholder(read.value)
    ? readAbsent("publisher-typed-absence")
    : read;
};

/**
 * Fetch rich HTML from /DokumentOriginal/Html/{id} and parse it into a
 * DocumentAst. Falls back to /Text/{id} for plain fulltext where the portal
 * holds no rich original or the parser cannot read what it served. A failed
 * read of either endpoint is reported unavailable, never replaced by the
 * other representation.
 */
const fetchDecisionContent = async (
  documentId: string,
  row: ParsedRow,
  detail: CzNssDetailMetadata,
  session: SessionState,
  signal: AbortSignal,
): Promise<DecisionContentRead> => {
  const rich = await fetchRichDocument(documentId, session, signal);
  switch (rich.type) {
    case "present":
      break;
    case "absent":
      return await fetchPlainTextContent(documentId, session, signal);
    case "refused":
    case "unavailable":
      return observeDocumentReadFailed({
        documentId,
        phase: CZ_NSS_RAW_PART.DOCUMENT,
        read: rich,
      });
    default:
      rich satisfies never;
      return panic(`Unhandled NSS document read: ${String(rich)}`);
  }
  const html = rich.value;
  const parsed = Result.try({
    try: () =>
      parseNssDecisionHtml({
        caseNumber: row.caseNumber,
        ecli: detail.ecli,
        court: czNssCourt(detail.ecli, documentId),
        decisionDate: (() => {
          if (detail.decisionDate) {
            return parseCeDate(detail.decisionDate);
          }
          if (row.decisionDate) {
            return parseCeDate(row.decisionDate);
          }
          return undefined;
        })(),
        decisionType: (detail.decisionType ?? row.decisionType)?.toLowerCase(),
        sourceUrl: row.documentUrl,
        html,
        detailMetadata: { ...detail },
      }),
    catch: (cause: unknown) => cause,
  });
  if (Result.isOk(parsed)) {
    return {
      type: "read",
      content: {
        fulltext: parsed.value.fulltext,
        documentAst: parsed.value.documentAst,
        sourceRaw: html,
        fallbackText: undefined,
      },
    };
  }
  // Each parser failure is reported, which keeps it apart from decisions
  // the portal serves as plain text. It is observed unclassified, as the
  // parser's own failure.
  observeFailure(parsed.error, {
    sink: documentParseFailed,
    ctx: { adapterKey: ADAPTER_KEYS.CZ_NSS, documentId },
  });
  return await fetchPlainTextContent(documentId, session, signal);
};

/**
 * Read plain text from /DokumentOriginal/Text/{id}, which the portal serves
 * as UTF-16. A 404 or 410 states the portal has no text either: the content
 * is empty and the row is stored listing-only. A failed read, an empty body
 * included, is reported unavailable.
 */
const fetchPlainTextContent = async (
  documentId: string,
  session: SessionState,
  signal: AbortSignal,
): Promise<DecisionContentRead> => {
  // The bounded byte read reports an empty, oversized or failed body as
  // unavailable, and rethrows a read the page's signal aborted.
  const read = await readPublisherBytes(
    `${BASE_URL}/DokumentOriginal/Text/${documentId}`,
    {
      fetchStage: "document",
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      signal,
      headers: {
        ...COMMON_HEADERS,
        Cookie: session.cookies,
      },
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      refusalScope: "document",
    },
  );
  switch (read.type) {
    case "present":
      break;
    case "absent":
      return { type: "read", content: EMPTY_CONTENT };
    case "refused":
    case "unavailable":
      return observeDocumentReadFailed({
        documentId,
        phase: CZ_NSS_RAW_PART.TEXT,
        read,
      });
    default:
      read satisfies never;
      return panic(`Unhandled NSS text read: ${String(read)}`);
  }
  const text = new TextDecoder("utf-16").decode(read.value);
  const body = stripHtml(text);
  const usable = body.length > CZ_NSS_MIN_FULLTEXT_CHARS;
  return {
    type: "read",
    content: {
      fulltext: usable ? body : undefined,
      documentAst: undefined,
      sourceRaw: undefined,
      // Decoded rather than verbatim: the endpoint serves UTF-16, and the raw
      // is stored as text. It is the payload this row's fulltext came from.
      fallbackText: usable ? text : undefined,
    },
  };
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every field the portal states on the detail page read for one decision.
 *
 * The portal names each one in a `data-field-id` attribute, and prints the
 * fields a document has: a decision the court wrote no headnote for carries
 * the flag and not the sentence, one that never left a regional court carries
 * no cassation block. The list is therefore the union over the document kinds
 * the portal serves, and {@link listCzNssSourceFields} reads back whichever of
 * them one page states.
 *
 * Declared once so the disposition map below is total by type: a field id
 * added here without a disposition does not compile.
 */
const CZ_NSS_SOURCE_FIELDS = [
  "aktualizovano",
  "aplikovanepravnipredpisysb§",
  "aplikovanepravnipredpisysbcislo",
  "aplikovanepravnipredpisysbcl",
  "aplikovanepravnipredpisysbodst",
  "aplikovanepravnipredpisysbpism",
  "aplikovanepravnipredpisysbpredpis",
  "aplikovanepravnipredpisysbrok",
  "aplikovanopravoeu",
  "citace",
  "cj",
  "datumnapadenehorozhodnuti",
  "datumpravnimoci",
  "datumpredkladacihorozhodnutinss",
  "datumrozhodnutikrajskehosoudu",
  "datumskonceniirizeni",
  "datumvydanirozhodnuti",
  "datumvyhotovenirozhodnuti",
  "datumvypravenirozhodnuti",
  "datumzahajenirizeni",
  "datumzahajenirizeninka",
  "druh",
  "druhdokumentuavyrokrozhodnuti",
  "ecli",
  "hvtparagrafy",
  "identifikacevesbirkach",
  "identifikacevesbirkachdelenejudikat",
  "identifikacevesbirkachdelenerok",
  "identifikacevesbirkachdelenesesit",
  "kasacnistiznostoznacenivecideleneclistu",
  "kasacnistiznostoznacenivecideleneporc",
  "kasacnistiznostoznacenivecidelenerejstrik",
  "kasacnistiznostoznacenivecidelenerok",
  "kasacnistiznostoznacenivecidelenesenat",
  "kasacnistiznostoznacenivecivcelku",
  "kasacniustavnistiznost",
  "krajskysoud",
  "napadeno",
  "nazevorganu",
  "nazevsoudusubjektu",
  "nazevspravnihoorganu",
  "oblastupravy",
  "oznacenivecidelenecislojednaci",
  "oznacenivecideleneporadovecislo",
  "oznacenivecidelenerejstrikovaznacka",
  "oznacenivecidelenerok",
  "oznacenivecidelenesenat",
  "oznacenivecivcelku",
  "podanakasacnistiznostD",
  "povaha",
  "pravnivetaanv",
  "pravnivetaupravena",
  "prejudikaturaoznacenivecideleneclistu",
  "prejudikaturaoznacenivecideleneporc",
  "prejudikaturaoznacenivecidelenerejstrik",
  "prejudikaturaoznacenivecidelenerok",
  "prejudikaturaoznacenivecidelenesenat",
  "prejudikaturaoznacenivecivcelku",
  "rozhodnuto",
  "rozhodnutivevztahukrizeni",
  "rozhodnutonapkasst",
  "sbnsspublikovano",
  "souladnaprejudikatura",
  "soudcezpravodaj",
  "soudsenat",
  "spzncjpredkladacihorozhodnutinss",
  "spzncjrizenipodani",
  "spzncjrozhodnutispravnihoorganu",
  "stavrizeni",
  "sz",
  "typrizeni",
  "typucastnika",
  "typzastupce",
  "ucastnicirizeniz",
  "ucastnikrizeni",
  "vyrokrozhodnuti",
  "zastupce",
  "zobrazovanedatum",
] as const;

type CzNssSourceField = (typeof CZ_NSS_SOURCE_FIELDS)[number];

/**
 * Why a family of fields is left. Written once per family rather than once per
 * field: the portal splits one fact across a row of columns, and a reason
 * repeated per column would read as seven decisions where one was taken.
 */
const CZ_NSS_EXCLUSION = {
  LISTING_REFERENCE:
    "The reference this document is filed under, whole and split per part. The row is stored under the reference the listing states, as published, with the docket and sheet split off it.",
  RELATED_CASE_LAW:
    "The portal's cross-reference grid naming other decisions, one column per part of each reference. This row's citations are extracted from the decision text; the portal's list is not a field of the row.",
  PROCEEDING_HISTORY:
    "The proceeding around the document: what was challenged, which court or authority it came from, and what became of it afterwards. The row models one decision and carries no field for the proceeding.",
  PROCEEDING_DATES:
    "Docket dates of the proceeding — opened, closed, in legal force, written out, dispatched. The row states the decision date, which is what a citation and a date filter ask for.",
  PARTY_GRID:
    "Columns of the participants grid: each party, its role, its representative and that representative's kind. The participants line the portal states for the decision is stored; the grid repeats it per person, and a decision row keeps no personal detail beyond what the decision itself states.",
  REPORTER_PUBLICATION:
    "How the portal identifies the decision inside the court's own reporter, and whether it appeared there at all. The row has no reporter-publication field; the reporter citation itself is stored as `citation`.",
  APPLIED_LEGISLATION:
    "The applied-legislation grid, one column per part of a reference (act, year, number, section, paragraph, letter, article). This source's rows carry no statute list, and reading the columns would mean rebuilding references the grid splits apart.",
  PORTAL_RECORD:
    "What the portal states about its own record rather than about the decision: when the entry was refreshed, which date its result list sorts on, and the paragraph-search aid printed beside it.",
} as const;

const CZ_NSS_SOURCE_FIELD_DISPOSITIONS = {
  aktualizovano: excludedSourceField(CZ_NSS_EXCLUSION.PORTAL_RECORD),
  "aplikovanepravnipredpisysb§": excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanepravnipredpisysbcislo: excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanepravnipredpisysbcl: excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanepravnipredpisysbodst: excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanepravnipredpisysbpism: excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanepravnipredpisysbpredpis: excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanepravnipredpisysbrok: excludedSourceField(
    CZ_NSS_EXCLUSION.APPLIED_LEGISLATION,
  ),
  aplikovanopravoeu: excludedSourceField(CZ_NSS_EXCLUSION.APPLIED_LEGISLATION),
  citace: {
    disposition: "stored",
    target: { type: "metadata", key: "citation" },
  },
  cj: excludedSourceField(CZ_NSS_EXCLUSION.LISTING_REFERENCE),
  datumnapadenehorozhodnuti: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  datumpravnimoci: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_DATES),
  datumpredkladacihorozhodnutinss: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  datumrozhodnutikrajskehosoudu: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  datumskonceniirizeni: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_DATES),
  datumvydanirozhodnuti: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  datumvyhotovenirozhodnuti: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_DATES,
  ),
  datumvypravenirozhodnuti: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_DATES,
  ),
  datumzahajenirizeni: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_DATES),
  datumzahajenirizeninka: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  druh: excludedSourceField(CZ_NSS_EXCLUSION.PARTY_GRID),
  druhdokumentuavyrokrozhodnuti: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  ecli: { disposition: "stored", target: { type: "result", key: "ecli" } },
  hvtparagrafy: excludedSourceField(CZ_NSS_EXCLUSION.PORTAL_RECORD),
  identifikacevesbirkach: excludedSourceField(
    CZ_NSS_EXCLUSION.REPORTER_PUBLICATION,
  ),
  identifikacevesbirkachdelenejudikat: excludedSourceField(
    CZ_NSS_EXCLUSION.REPORTER_PUBLICATION,
  ),
  identifikacevesbirkachdelenerok: excludedSourceField(
    CZ_NSS_EXCLUSION.REPORTER_PUBLICATION,
  ),
  identifikacevesbirkachdelenesesit: excludedSourceField(
    CZ_NSS_EXCLUSION.REPORTER_PUBLICATION,
  ),
  kasacnistiznostoznacenivecideleneclistu: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  kasacnistiznostoznacenivecideleneporc: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  kasacnistiznostoznacenivecidelenerejstrik: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  kasacnistiznostoznacenivecidelenerok: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  kasacnistiznostoznacenivecidelenesenat: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  kasacnistiznostoznacenivecivcelku: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  kasacniustavnistiznost: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  krajskysoud: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_HISTORY),
  napadeno: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_HISTORY),
  nazevorganu: excludedSourceField(CZ_NSS_EXCLUSION.PARTY_GRID),
  nazevsoudusubjektu: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_HISTORY),
  nazevspravnihoorganu: {
    disposition: "stored",
    target: { type: "metadata", key: "administrativeAuthority" },
  },
  oblastupravy: {
    disposition: "stored",
    target: { type: "metadata", key: "legalArea" },
  },
  oznacenivecidelenecislojednaci: excludedSourceField(
    CZ_NSS_EXCLUSION.LISTING_REFERENCE,
  ),
  oznacenivecideleneporadovecislo: excludedSourceField(
    CZ_NSS_EXCLUSION.LISTING_REFERENCE,
  ),
  oznacenivecidelenerejstrikovaznacka: excludedSourceField(
    CZ_NSS_EXCLUSION.LISTING_REFERENCE,
  ),
  oznacenivecidelenerok: excludedSourceField(
    CZ_NSS_EXCLUSION.LISTING_REFERENCE,
  ),
  oznacenivecidelenesenat: excludedSourceField(
    CZ_NSS_EXCLUSION.LISTING_REFERENCE,
  ),
  oznacenivecivcelku: excludedSourceField(CZ_NSS_EXCLUSION.LISTING_REFERENCE),
  podanakasacnistiznostD: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  povaha: excludedSourceField(CZ_NSS_EXCLUSION.RELATED_CASE_LAW),
  pravnivetaanv: excludedSourceField(
    "The ano/ne flag stating whether the court wrote a headnote for this decision. The headnote itself is stored, so the flag only repeats whether that field is there.",
  ),
  pravnivetaupravena: {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  prejudikaturaoznacenivecideleneclistu: excludedSourceField(
    CZ_NSS_EXCLUSION.RELATED_CASE_LAW,
  ),
  prejudikaturaoznacenivecideleneporc: excludedSourceField(
    CZ_NSS_EXCLUSION.RELATED_CASE_LAW,
  ),
  prejudikaturaoznacenivecidelenerejstrik: excludedSourceField(
    CZ_NSS_EXCLUSION.RELATED_CASE_LAW,
  ),
  prejudikaturaoznacenivecidelenerok: excludedSourceField(
    CZ_NSS_EXCLUSION.RELATED_CASE_LAW,
  ),
  prejudikaturaoznacenivecidelenesenat: excludedSourceField(
    CZ_NSS_EXCLUSION.RELATED_CASE_LAW,
  ),
  prejudikaturaoznacenivecivcelku: excludedSourceField(
    CZ_NSS_EXCLUSION.RELATED_CASE_LAW,
  ),
  rozhodnuto: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_HISTORY),
  rozhodnutivevztahukrizeni: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  rozhodnutonapkasst: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_HISTORY),
  sbnsspublikovano: excludedSourceField(CZ_NSS_EXCLUSION.REPORTER_PUBLICATION),
  souladnaprejudikatura: excludedSourceField(CZ_NSS_EXCLUSION.RELATED_CASE_LAW),
  soudcezpravodaj: {
    disposition: "stored",
    target: { type: "metadata", key: "judge" },
  },
  soudsenat: {
    disposition: "stored",
    target: { type: "metadata", key: "senate" },
  },
  spzncjpredkladacihorozhodnutinss: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  spzncjrizenipodani: excludedSourceField(CZ_NSS_EXCLUSION.PROCEEDING_HISTORY),
  spzncjrozhodnutispravnihoorganu: excludedSourceField(
    CZ_NSS_EXCLUSION.PROCEEDING_HISTORY,
  ),
  stavrizeni: {
    disposition: "stored",
    target: { type: "metadata", key: "caseStatus" },
  },
  sz: excludedSourceField(CZ_NSS_EXCLUSION.LISTING_REFERENCE),
  typrizeni: {
    disposition: "stored",
    target: { type: "metadata", key: "caseType" },
  },
  typucastnika: excludedSourceField(CZ_NSS_EXCLUSION.PARTY_GRID),
  typzastupce: excludedSourceField(CZ_NSS_EXCLUSION.PARTY_GRID),
  ucastnicirizeniz: {
    disposition: "stored",
    target: { type: "metadata", key: "parties" },
  },
  ucastnikrizeni: excludedSourceField(CZ_NSS_EXCLUSION.PARTY_GRID),
  vyrokrozhodnuti: {
    disposition: "stored",
    target: { type: "metadata", key: "outcome" },
  },
  zastupce: excludedSourceField(CZ_NSS_EXCLUSION.PARTY_GRID),
  zobrazovanedatum: excludedSourceField(CZ_NSS_EXCLUSION.PORTAL_RECORD),
} as const satisfies Record<CzNssSourceField, SourceFieldDisposition>;

/** How the portal names each field it prints on a detail page. */
const CZ_NSS_FIELD_ID_RE = /data-field-id="(?<field>[^"]+)"/giu;

/** Numeric character references, which ids such as `…sb&#xA7;` carry. */
const NUMERIC_ENTITY_RE = /&#(?<hex>x[0-9a-f]+|\d+);/giu;

const decodeNumericEntities = (value: string): string =>
  value.replaceAll(NUMERIC_ENTITY_RE, (match, reference: string) => {
    const code = reference.startsWith("x")
      ? Number.parseInt(reference.slice(1), 16)
      : Number.parseInt(reference, 10);
    return Number.isNaN(code) ? match : String.fromCodePoint(code);
  });

/**
 * What the portal states as a field, by the names it gives them.
 *
 * The detail part is the only one that names fields: the document and the
 * plain-text rendering beside it are the decision itself, under no labels.
 */
const listCzNssSourceFields = (parts: SourceRawParts): readonly string[] => [
  ...new Set(
    [...(parts[CZ_NSS_RAW_PART.DETAIL] ?? "").matchAll(CZ_NSS_FIELD_ID_RE)].map(
      (match) => decodeNumericEntities(match.groups?.["field"] ?? ""),
    ),
  ),
];

/**
 * The fields the portal states on a document's own detail page, which no
 * document endpoint carries. Exported under the adapter's name because a
 * second reader — a backfill that fetches this page for the headnote alone —
 * must bind to the same shape rather than restate its keys.
 */
export type CzNssDetailMetadata = {
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
  legalSentence: string | undefined;
};

type ExtractDivTextOptions = {
  html: string;
  divId: string;
  emptyValue?: "preserve" | "omit";
};

/** Extract a div's value text by its ID, skipping the label span. */
const extractDivText = ({
  html,
  divId,
  emptyValue = "omit",
}: ExtractDivTextOptions): string | undefined => {
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
  let statedValueCount = 0;
  while ((valMatch = valPattern.exec(match[1])) !== null) {
    statedValueCount += 1;
    const text = stripHtml(valMatch.groups?.["value"] ?? "").trim();
    if (text) {
      texts.push(text);
    }
  }
  if (texts.length > 0) {
    return texts.join(", ");
  }

  return emptyValue === "preserve" && statedValueCount > 0 ? "" : undefined;
};

/**
 * Read the detail page's fields out of its markup.
 *
 * Split from the fetch below so a caller that already holds the page — a
 * backfill reading the headnote off it, its own tests — parses it through
 * the adapter rather than through a second copy of these field names.
 */
export const parseCzNssDetailMetadata = (
  html: string,
): CzNssDetailMetadata => ({
  ecli: extractDivText({ html, divId: "ecli" }),
  judge: extractDivText({ html, divId: "soudcezpravodaj" }),
  senate: extractDivText({ html, divId: "soudsenat" }),
  legalArea: extractDivText({ html, divId: "oblastupravy" }),
  decisionType: statedDecisionType(
    extractDivText({ html, divId: "druhdokumentuavyrokrozhodnuti" }),
  ),
  decisionDate: extractDivText({ html, divId: "datumvydanirozhodnuti" }),
  outcome: extractDivText({ html, divId: "vyrokrozhodnuti" }),
  caseType: extractDivText({ html, divId: "typrizeni" }),
  parties: extractDivText({ html, divId: "ucastnicirizeniz" }),
  caseStatus: extractDivText({ html, divId: "stavrizeni" }),
  administrativeAuthority: extractDivText({
    html,
    divId: "nazevspravnihoorganu",
  }),
  citation: extractDivText({ html, divId: "citace" }),
  // The headnote the court writes for a decision it selects into its
  // collection, under `pravnivetaupravena` ("Právní věta (text)"). The
  // neighbouring `pravnivetaanv` is the ano/ne flag, not the sentence,
  // and the field is on the detail page alone: neither document
  // endpoint carries it.
  legalSentence: extractDivText({
    html,
    divId: "pravnivetaupravena",
    emptyValue: "preserve",
  }),
});

/**
 * Fetch structured metadata from /DokumentDetail/Index/{id}.
 * Extracts ECLI, judge, legal area, decision type, outcome,
 * case type, and parties.
 */
const EMPTY_DETAIL: CzNssDetailMetadata = {
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
  legalSentence: undefined,
};

/**
 * The detail page, or the fact that it could not be read.
 *
 * A portal that answers 404 or 410 has no metadata for the document, and the
 * row is built without it. A timeout, a failed request, a server error, a 204
 * or an empty body is not that: the metadata exists and was not read. Such a
 * document is reported as unavailable; the crawl stores it as a listing-only
 * row, which the
 * reconciliation does not count as held and so reads again, and the
 * reconciliation itself parks it for a later attempt. A page the parser
 * throws on is reported as the parser's failure and held the same way.
 *
 * A read the page's signal aborts is rethrown to the crawl. When the page's
 * own read budget ran out, the crawl stores this row and the rest of the page
 * listing-only and moves on; when the caller's signal aborted, it fails the
 * page.
 */
type DetailFetch =
  | { type: "fetched"; detail: CzNssDetailMetadata; html: string | null }
  | { type: "unavailable"; readOutcome: StoredReadOutcome | null };

const fetchDetailMetadata = async (
  documentId: string,
  session: SessionState,
  signal: AbortSignal,
): Promise<DetailFetch> => {
  const read = await readPublisherText(
    `${BASE_URL}/DokumentDetail/Index/${documentId}`,
    {
      fetchStage: "document",
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      signal,
      headers: {
        ...COMMON_HEADERS,
        Cookie: session.cookies,
      },
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      refusalScope: "document",
    },
  );
  switch (read.type) {
    case "present":
      break;
    case "absent":
      return { type: "fetched", detail: EMPTY_DETAIL, html: null };
    case "refused":
    case "unavailable":
      observeFailure(
        publisherReadFailure(
          unreadPublisherError({
            outcome: read,
            message: "NSS detail read failed",
            adapterKey: ADAPTER_KEYS.CZ_NSS,
            cursor: null,
          }),
        ),
        {
          sink: detailReadFailed,
          ctx: { adapterKey: ADAPTER_KEYS.CZ_NSS, documentId },
        },
      );
      return {
        type: "unavailable",
        readOutcome: storedDocumentReadOutcome(read),
      };
    default:
      read satisfies never;
      return panic(`Unhandled NSS detail read: ${String(read)}`);
  }
  const html = read.value;
  const parsed = Result.try({
    try: () => parseCzNssDetailMetadata(html),
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(parsed)) {
    // Observed unclassified, as the parser's own failure, and the row is held
    // like an unread one.
    observeFailure(parsed.error, {
      sink: detailParseFailed,
      ctx: { adapterKey: ADAPTER_KEYS.CZ_NSS, documentId },
    });
    return { type: "unavailable", readOutcome: null };
  }
  return { type: "fetched", detail: parsed.value, html };
};

/**
 * The listing row as stored, with its fields in one fixed order. A row the
 * reconciliation parked comes back from JSONB with its keys reordered, and the
 * same row must store the same bytes whichever path built it.
 */
const storedListingRow = ({
  caseNumber,
  publishedCaseNumber,
  decisionDate,
  decisionType,
  outcome,
  documentUrl,
  documentId,
}: ParsedRow): string =>
  JSON.stringify({
    caseNumber,
    publishedCaseNumber,
    decisionDate,
    decisionType,
    outcome,
    documentUrl,
    documentId,
  } satisfies Record<keyof ParsedRow, unknown>);

type RowToResultOptions = {
  row: ParsedRow;
  content: DecisionContent;
  detail: CzNssDetailMetadata;
  /** The detail page as served, where it was read for this document. */
  detailHtml: string | null;
};

/**
 * The metadata keys a detail page fills, written once so the crawl and the
 * stored-raw replay cannot drift into filling different ones.
 */
const detailMetadataFields = (
  detail: CzNssDetailMetadata,
): Record<string, unknown> => ({
  ecli: detail.ecli,
  judge: detail.judge,
  senate: detail.senate,
  legalArea: detail.legalArea,
  decisionType: detail.decisionType,
  decisionDate: detail.decisionDate,
  outcome: detail.outcome,
  caseType: detail.caseType,
  parties: detail.parties,
  caseStatus: detail.caseStatus,
  administrativeAuthority: detail.administrativeAuthority,
  citation: detail.citation,
});

/** The keys a detail page states a value for, for a replay that merges them. */
const statedDetailMetadataFields = (
  detail: CzNssDetailMetadata,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(detailMetadataFields(detail)).filter(
      ([, value]) => value !== undefined,
    ),
  );

/** An explicitly blank NSS prose value is a publisher placeholder. */
const czNssTextField = (raw: string | undefined) => {
  if (raw?.trim().length === 0) {
    return absentTextField(TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER);
  }
  return sourceTextField(ADAPTER_KEYS.CZ_NSS, raw);
};

/** Convert a parsed row into an IngestionResult. */
const rowToResult = ({
  content,
  detail,
  detailHtml,
  row,
}: RowToResultOptions): IngestionResult => {
  const sourceDocumentId = czNssSourceDocumentId(row);
  const legalSentenceField = czNssTextField(detail.legalSentence);
  const court = czNssCourt(detail.ecli, sourceDocumentId);
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
  const reporterIdentifiers = nssReporterIdentifiers(detail.citation);
  // This source publishes the docket with the sheet number appended.
  const publishedCaseNumber = row.publishedCaseNumber ?? row.caseNumber;
  const { sheetNumber } = splitCaseReference(publishedCaseNumber);
  const rawParts = {
    ...(content.sourceRaw === undefined
      ? {}
      : { [CZ_NSS_RAW_PART.DOCUMENT]: content.sourceRaw }),
    ...(content.fallbackText === undefined
      ? {}
      : { [CZ_NSS_RAW_PART.TEXT]: content.fallbackText }),
    ...(detailHtml === null ? {} : { [CZ_NSS_RAW_PART.DETAIL]: detailHtml }),
    [CZ_NSS_RAW_PART.LISTING]: storedListingRow(row),
  };
  const sourceRaw = encodeSourceRawEnvelope(rawParts);

  return plainTextIngestionResult({
    caseNumber: row.caseNumber,
    sheetNumber,
    ...(reporterIdentifiers === undefined
      ? {}
      : { identifiers: reporterIdentifiers }),
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
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NSS].country,
    language: CZ_NSS_LANGUAGE,
    decisionDate,
    // Prefer structured decisionType from detail page over
    // the heuristic cell match from the search results table
    decisionType,
    fulltext: content.fulltext,
    sourceUrl: row.documentUrl,
    documentUrl: row.documentUrl,
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      legalSentence: legalSentenceField,
    },
    metadata: checkedDecisionMetadata({
      caseNumber: row.caseNumber,
      sheetNumber,
      // The reference exactly as the court publishes it, docket and sheet
      // together, so the split stays reversible from what we stored.
      publishedCaseNumber,
      court,
      ...detailMetadataFields(detail),
      // The listing states an outcome for rows whose detail page does not.
      outcome: detail.outcome ?? row.outcome,
    }),
    rawHash: sourceFingerprint({ sourceRaw }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS],
    documentAst: content.documentAst ?? EMPTY_AST,
    // Every response fetched for this decision, not just the one the parser
    // reads: the headnote and the rest of the portal's metadata are on the
    // detail page, so a row that stored the document alone could never recover
    // a field read later without going back to the court.
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
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

/**
 * The document a stored payload holds: the rich HTML the parser reads, or the
 * plain text the portal serves where that endpoint answered instead.
 */
type StoredDocument =
  | { type: "html"; html: string }
  | { type: "text"; text: string };

const storedDocumentOf = (
  raw: string,
  parts: SourceRawParts | null,
): StoredDocument | null => {
  // A payload that is not an envelope is a row stored when the raw held the
  // rich document alone.
  if (parts === null) {
    return { type: "html", html: raw };
  }
  const html = parts[CZ_NSS_RAW_PART.DOCUMENT];
  if (html !== undefined) {
    return { type: "html", html };
  }
  const text = parts[CZ_NSS_RAW_PART.TEXT];
  return text === undefined ? null : { type: "text", text };
};

type RebuildStoredDocumentOptions = {
  document: StoredDocument;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  detailMetadata: Record<string, unknown>;
};

type RebuiltDocument = {
  fulltext: string | undefined;
  documentAst: DocumentAst | EmptyAst;
};

/**
 * What the crawl built from this payload, rebuilt from the payload alone, or
 * `null` where it holds nothing a row could be stored on.
 */
const rebuildStoredDocument = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
  detailMetadata,
  document,
  ecli,
  sourceUrl,
}: RebuildStoredDocumentOptions): RebuiltDocument | null => {
  if (document.type === "text") {
    // The same reading the crawl takes from this endpoint, down to the floor
    // that tells a document from a portal error page.
    const body = stripHtml(document.text);
    return body.length > CZ_NSS_MIN_FULLTEXT_CHARS
      ? { fulltext: body, documentAst: EMPTY_AST }
      : null;
  }

  const parsed = parseNssDecisionHtml({
    caseNumber,
    ecli,
    court,
    decisionDate,
    decisionType,
    sourceUrl,
    html: document.html,
    detailMetadata,
  });

  return parsed.documentAst.blocks.length === 0
    ? null
    : { fulltext: parsed.fulltext, documentAst: parsed.documentAst };
};

/**
 * Rebuild one NSS decision from what the crawl stored for it.
 *
 * Two payload shapes reach this, and the difference is what a replay can
 * recover. A row stored since the raw became an envelope carries the document
 * and the detail page, so the replay derives the portal's metadata from the
 * page itself and a field first read later lands on the row. A row stored
 * before it carries the document alone: its metadata is whatever the ingest
 * of the day wrote, and only a re-crawl can add to it.
 *
 * The document itself is whichever of the two endpoints answered for this
 * decision, and a replay rebuilds what the crawl built from it: an AST from
 * the rich HTML, plain fulltext under an empty AST from the text endpoint. A
 * replay that read only the rich part would reject every text-served row as
 * having no document, which is a row the crawl stored quite deliberately.
 */
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

  const raw = new TextDecoder().decode(stored.raw);
  const parts = decodeSourceRawEnvelope(raw);
  const storedDocument = storedDocumentOf(raw, parts);
  const storedDetailHtml = parts?.[CZ_NSS_RAW_PART.DETAIL];
  const storedDetail =
    storedDetailHtml === undefined
      ? undefined
      : parseCzNssDetailMetadata(storedDetailHtml);
  const sourceUrl = stored.sourceUrl ?? undefined;
  const decisionDate = stored.decisionDate ?? undefined;
  // Re-read through the same guard, so a replay clears a docket number an
  // earlier parse stored as the type.
  const decisionType = statedDecisionType(stored.decisionType ?? undefined);
  const ecli = stored.ecli ?? undefined;
  const rebuilt =
    storedDocument === null
      ? null
      : rebuildStoredDocument({
          document: storedDocument,
          caseNumber: stored.caseNumber,
          ecli,
          court: stored.court,
          decisionDate,
          decisionType,
          sourceUrl,
          detailMetadata: stored.metadata,
        });

  if (rebuilt === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `no document parsed from the stored payload for ${stored.caseNumber}`,
    };
  }

  const citation =
    nonEmptyString(storedDetail?.citation) ??
    nonEmptyString(stored.metadata["citation"]);
  const reporterIdentifiers = nssReporterIdentifiers(citation);
  const sourceDocumentId = stored.sourceDocumentId ?? undefined;
  const publishedCaseNumber = storedPublishedCaseNumber(stored);
  const { sheetNumber } = splitCaseReference(publishedCaseNumber);
  const storedDecisionText = splitStoredDecisionTextMetadata(stored.metadata);
  const textFields = { ...storedDecisionText.textFields };
  // Only legacy text without a sidecar, or text already read as present, can
  // be reclassified. A sidecar's absence (including quarantine) stays closed.
  for (const key of DECISION_TEXT_FIELD_KEYS) {
    const storedText = stored.metadata[key];
    const field = textFields[key];
    if (
      typeof storedText === "string" &&
      (field.type === TEXT_FIELD_TYPE.PRESENT ||
        stored.metadata[DECISION_TEXT_ABSENCE_METADATA_KEY] === undefined)
    ) {
      textFields[key] = czNssTextField(storedText);
    }
  }
  const statedLegalSentence = storedDetail?.legalSentence;
  const legalSentenceField =
    statedLegalSentence === undefined
      ? textFields.legalSentence
      : czNssTextField(statedLegalSentence);

  return {
    type: "parsed",
    result: plainTextIngestionResult({
      caseNumber: stored.caseNumber,
      sheetNumber,
      ...(reporterIdentifiers === undefined
        ? {}
        : { identifiers: reporterIdentifiers }),
      sourceDocumentId,
      ...(sourceDocumentId === undefined
        ? {}
        : { legacySourceUrls: [detailUrl(sourceDocumentId)] }),
      ecli,
      court: stored.court,
      country: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NSS].country,
      language: stored.language,
      decisionDate,
      decisionType,
      fulltext: rebuilt.fulltext,
      sourceUrl,
      documentUrl: stored.documentUrl ?? undefined,
      textFields: {
        ...textFields,
        legalSentence: legalSentenceField,
      },
      // Written back rather than passed through: a legacy row states the
      // reference only in `metadata.caseNumber`, and a replay that left the
      // metadata as it found it would leave the split unreversible for good.
      // For a row stored since, these are the values already there.
      metadata: checkedDecisionMetadata({
        ...storedDecisionText.metadata,
        // What the stored detail page states wins over what the row holds: the
        // page is the publisher's, the row is what an older parser made of it.
        ...(storedDetail === undefined
          ? {}
          : statedDetailMetadataFields(storedDetail)),
        sheetNumber,
        publishedCaseNumber,
      }),
      // Over the payload the replay keeps, so a row the crawl stored replays
      // to the hash the crawl gave it.
      rawHash: sourceFingerprint({ sourceRaw: raw }),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS],
      documentAst: rebuilt.documentAst,
      // The payload verbatim, in the shape it was stored in: a replay re-reads
      // a decision, it does not rewrite what the crawl fetched for it.
      sourceRaw: raw,
      sourceRawContentType: stored.contentType ?? "text/html",
    }),
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
  const read = await readPublisher(BASE_URL, {
    fetchStage: "listing",
    adapterKey: ADAPTER_KEYS.CZ_NSS,
    signal,
    redirect: "follow",
    headers: COMMON_HEADERS,
    timeoutMs: CZ_NSS_LISTING_TIMEOUT_MS,
    refusalScope: "source",
  });

  if (read.type !== "present") {
    throw unreadPublisherError({
      outcome: read,
      message: "NSS session init failed",
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      cursor: null,
    });
  }

  const response = read.value;
  const htmlRead = await readBodyText(read, signal);
  if (htmlRead.type !== "present") {
    throw unreadPublisherError({
      outcome: htmlRead,
      message: "NSS session init failed",
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      cursor: null,
    });
  }
  const html = htmlRead.value;
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
  if (
    cachedSession &&
    Temporal.Now.instant().epochMilliseconds - cachedSession.createdAt <
      SESSION_TTL_MS
  ) {
    return cachedSession.state;
  }

  const state = await initSession(signal);
  cachedSession = {
    state,
    createdAt: Temporal.Now.instant().epochMilliseconds,
  };
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

type SearchResult =
  | {
      type: "present";
      html: string;
      continuation: ListingContinuation;
      statedCount: number;
    }
  | { type: "absent"; html: string; statedCount: 0 }
  | { type: "missing-count"; error: AdapterFetchError }
  | { type: "unavailable"; error: AdapterFetchError };

/** Reconciliation refuses uncounted searches; the crawl bounds them before this boundary. */
const requireSearchResult = (read: SearchResult) => {
  switch (read.type) {
    case "present":
    case "absent":
      return read;
    case "missing-count":
    case "unavailable":
      invalidateSession();
      throw read.error;
    default:
      read satisfies never;
      return panic(`Unexpected NSS search read: ${JSON.stringify(read)}`);
  }
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

  const read = await readPublisher(`${BASE_URL}/Home/Index`, {
    fetchStage: "listing",
    adapterKey: ADAPTER_KEYS.CZ_NSS,
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
    refusalScope: "source",
  });

  if (read.type !== "present") {
    return {
      type: "unavailable",
      error: unreadPublisherError({
        outcome: read,
        message: "NSS search failed",
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: date,
      }),
    };
  }
  const response = read.value;

  // Merge any new cookies (overwriting stale names)
  const newCookies = extractCookies(response);
  if (newCookies) {
    session.cookies = mergeCookies(session.cookies, newCookies);
  }

  const htmlRead = await readBodyText(read, signal);
  if (htmlRead.type !== "present") {
    return {
      type: "unavailable",
      error: unreadPublisherError({
        outcome: htmlRead,
        message: "NSS search failed",
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: date,
      }),
    };
  }
  const html = htmlRead.value;

  const statedCount = statedResultCount(html);
  if (statedCount === null) {
    return {
      type: "missing-count",
      error: new AdapterFetchError({
        message: `NSS stated no result count for ${date}`,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: date,
      }),
    };
  }
  if (statedCount === 0) {
    return { type: "absent", html, statedCount };
  }
  const continuation = extractContinuation(html);
  if (continuation === undefined || continuation.conditions === "[]") {
    return {
      type: "unavailable",
      error: new AdapterFetchError({
        message: `NSS results for ${date} carried no pagination state`,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: date,
      }),
    };
  }
  return { type: "present", html, continuation, statedCount };
};

type FetchResultPageOptions = {
  session: SessionState;
  continuation: ListingContinuation;
  /** The date being searched; error context only. */
  date: string;
  /** 0-indexed page within the day. */
  page: number;
  /**
   * What the day's results page said the search matched, or `null` where it
   * said nothing. It is the only thing that tells a page past the day's last
   * record from a query the endpoint refused.
   */
  statedCount: number | null;
  signal: AbortSignal;
};

/**
 * Fetch one page of results beyond the first, exactly as the portal's own
 * infinite scroll does: the field names, and the whole search query in the
 * body. The endpoint answers a body-only request, so a page is reachable
 * without the session that first ran the search.
 *
 * The two ways this fails are returned rather than thrown, so the one error
 * value is built here and each caller propagates it the way its own contract
 * requires: the crawl's `fetchPage` is already a `Result`, and the
 * reconciliation's page read is defined to throw.
 */
const fetchResultPage = async ({
  continuation,
  date,
  page,
  statedCount,
  session,
  signal,
}: FetchResultPageOptions): Promise<Result<string, AdapterFetchError>> => {
  const formData = new URLSearchParams();
  formData.set("vyhledavaciPodminky", continuation.conditions);
  formData.set("zobrazeniVysledkuId", continuation.viewId);
  formData.set("pageNum", String(page));
  formData.set("resultOrder", continuation.order);

  const read = await readPublisher(`${BASE_URL}/Home/MyResTRowsCont`, {
    fetchStage: "listing",
    adapterKey: ADAPTER_KEYS.CZ_NSS,
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
    refusalScope: "source",
  });

  if (read.type !== "present") {
    invalidateSession();
    return Result.err(
      unreadPublisherError({
        outcome: read,
        message: "NSS pagination failed",
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: `${date}:${page}`,
      }),
    );
  }

  const htmlRead = await readBodyText(read, signal);
  const emptyBody =
    htmlRead.type === "unavailable" && htmlRead.cause.kind === "empty-body";
  if (htmlRead.type !== "present" && !emptyBody) {
    invalidateSession();
    return Result.err(
      unreadPublisherError({
        outcome: htmlRead,
        message: "NSS pagination failed",
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: `${date}:${page}`,
      }),
    );
  }
  const html = htmlRead.type === "present" ? htmlRead.value : "";
  // Case-law rule 14: a day ends when the source says there is nothing more.
  // This endpoint answers 200 with an empty body for two different things —
  // a page past the day's last record, and a query it did not recognise —
  // and only the stated count tells them apart. Reading the second as the
  // first settles a day the walk saw a fraction of, and a forward-only
  // cursor never comes back to it. A day whose count the page did not state
  // is refused for the same reason: nothing here can say the day is over.
  const requiredRows =
    statedCount === null ? null : czNssExpectedRows({ page, statedCount });
  if (html.trim() === "" && requiredRows !== 0) {
    invalidateSession();
    return Result.err(
      new AdapterFetchError({
        message: `NSS pagination for ${date} answered no rows for page ${page}, which ${
          statedCount === null
            ? "the day's unstated record count cannot show is past its last record"
            : `its stated count of ${statedCount} requires ${czNssExpectedRows({ page, statedCount })} of`
        }`,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: `${date}:${page}`,
      }),
    );
  }

  return Result.ok(html);
};

// ── Shared build path ────────────────────────────────────

const EMPTY_CONTENT: DecisionContent = {
  fulltext: undefined,
  documentAst: undefined,
  sourceRaw: undefined,
  fallbackText: undefined,
};

/**
 * What building one listed row produced.
 *
 * `detail-unavailable` still carries the decision the listing alone describes,
 * marked `isListingOnly`, because the two callers dispose of it differently:
 * the crawl's cursor moves past this document, so it stores the listing-only
 * row, which the reconciliation does not count as held (`heldRequiresDetail`)
 * and reads again; the reconciliation itself parks the document for a later
 * attempt and writes nothing for it.
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
 * The row the listing alone describes, for a document that was not read.
 *
 * Marked `isListingOnly`, which keeps it off every public surface and out of
 * what the reconciliation counts as held. Its stored raw holds no readable
 * document, which every read row's does, so its hash differs from the one the
 * same document hashes to once read and the full row replaces it. Where a read
 * failed or was refused, the row states that outcome, typed, under
 * `metadata.readOutcome`.
 */
const listingOnlyDecision = (
  decision: IngestionResult,
  readOutcome: StoredReadOutcome | null,
): IngestionResult =>
  plainTextIngestionResult({
    ...decision,
    isListingOnly: true,
    ...(readOutcome === null
      ? {}
      : {
          metadata: {
            ...decision.metadata,
            [READ_OUTCOME_METADATA_KEY]: readOutcome,
          },
        }),
  });

/** The listing-only row for a listed document nothing was read for. */
const unreadRowDecision = (
  row: ParsedRow,
  readOutcome: StoredReadOutcome | null,
): IngestionResult =>
  listingOnlyDecision(
    rowToResult({
      row,
      content: EMPTY_CONTENT,
      detail: EMPTY_DETAIL,
      detailHtml: null,
    }),
    readOutcome,
  );

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
    // Only a payload parked by an older parser can reach this branch: current
    // listing rows require a persistable detail id. Nothing can be read for
    // the legacy row, now or later, so it remains a listing-only observation.
    return {
      type: "detail-unavailable",
      decision: unreadRowDecision(row, null),
    };
  }

  const detailFetch = await fetchDetailMetadata(documentId, session, signal);
  if (detailFetch.type === "unavailable") {
    return {
      type: "detail-unavailable",
      decision: unreadRowDecision(row, detailFetch.readOutcome),
    };
  }
  const { detail, html: detailHtml } = detailFetch;
  const contentRead = await fetchDecisionContent(
    documentId,
    row,
    detail,
    session,
    signal,
  );
  if (contentRead.type === "unavailable") {
    // A document read failed. The row is stored listing-only, exactly as for
    // a detail page that was not read, never built from another endpoint's
    // representation.
    return {
      type: "detail-unavailable",
      decision: listingOnlyDecision(
        rowToResult({ row, content: EMPTY_CONTENT, detail, detailHtml }),
        contentRead.readOutcome,
      ),
    };
  }
  const { content } = contentRead;
  const decision = rowToResult({ row, content, detail, detailHtml });

  // Both document endpoints answered with nothing usable. The metadata row is
  // still a decision to the crawl, stored listing-only so the reconciliation
  // reads the document again; to the reconciliation it is a document that has
  // not been read yet.
  return content.sourceRaw === undefined && content.fulltext === undefined
    ? {
        type: "detail-unavailable",
        decision: listingOnlyDecision(decision, null),
      }
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
export const CZ_NSS_FIRST_SLICE =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NSS].dateRange.fromInclusive;

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

/** The pipeline's deadline for one crawl page. */
const CZ_NSS_PAGE_TIMEOUT_MS = 120_000;

/**
 * How long one crawl page spends reading its rows' documents. Shorter than the
 * page deadline, so the page returns every listed row, read or listing-only,
 * before the pipeline's own page timer fires.
 */
const CZ_NSS_PAGE_READ_BUDGET_MS = 90_000;

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
 * A payload parked by an older parser without that link remains unidentifiable
 * rather than keyed on the docket alone. The current listing parser rejects it
 * before this boundary; keeping the branch lets persisted JSONB replay without
 * inventing an identity.
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
 * A failed request is thrown, never flattened into an empty page. Both walks
 * hold their progress when a search is unreadable. Only the court's own count
 * answers what a day holds: `Počet nalezených
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
  const search = requireSearchResult(
    await executeSearch(session, slice, effectiveSignal),
  );

  const firstPageRows = parseResultRows(search.html);
  if (search.type === "absent") {
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

  const continued =
    page === 0
      ? null
      : await fetchResultPage({
          continuation,
          date: slice,
          page,
          statedCount: search.statedCount,
          session,
          signal: effectiveSignal,
        });
  if (continued !== null && !Result.isOk(continued)) {
    // This read is defined to throw (see the note above), so the error the
    // fetch built is carried out as it stands rather than restated.
    const { error } = continued;
    throw error;
  }
  const rows =
    continued === null ? firstPageRows : parseResultRows(continued.value);

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
      // The decision the listing describes is not written here: the walk
      // parks the document and asks for it again on its own schedule.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled NSS build result: ${JSON.stringify(built)}`);
    }
  }
};

const CZ_NSS_MISSING_COUNT_ATTEMPTS = 3;

type CzNssCursor = {
  date: string;
  page: number;
  missingCountAttempts?: number;
};

const encodeCursor = (state: CzNssCursor): string =>
  state.missingCountAttempts === undefined
    ? `${state.date}:${state.page}`
    : JSON.stringify(state);

/** Retry state shares the pipeline's durable checkpoint. */
const parseCursor = (cursor: string | null): CzNssCursor => {
  if (cursor?.startsWith("{")) {
    const state: unknown = JSON.parse(cursor);
    if (
      !isRecord(state) ||
      typeof state["date"] !== "string" ||
      typeof state["page"] !== "number" ||
      !Number.isInteger(state["page"]) ||
      state["page"] < 0
    ) {
      return panic("Invalid NSS crawl cursor");
    }
    const attempts = state["missingCountAttempts"];
    if (
      attempts !== undefined &&
      (typeof attempts !== "number" ||
        !Number.isInteger(attempts) ||
        attempts < 0 ||
        attempts >= CZ_NSS_MISSING_COUNT_ATTEMPTS)
    ) {
      return panic("Invalid NSS count attempt checkpoint");
    }
    return {
      date: state["date"],
      page: state["page"],
      ...(typeof attempts === "number"
        ? { missingCountAttempts: attempts }
        : {}),
    };
  }
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

/**
 * Every page this portal serves for one decision, and whether the row keeps
 * it.
 *
 * The detail page and the rich document are kept. The result row is behind a
 * form postback and is not kept; the plain-text rendering is fetched only
 * where the rich document is missing, so no capture of a complete decision
 * carries it.
 */
const SOURCE_SURFACES = [
  "search-form",
  "listing",
  "detail",
  "document",
  "text",
  "original",
  "export",
  "citation-copy",
] as const;

const CZ_NSS_SOURCE_SURFACES = {
  surfaces: {
    "search-form": excludedSourceSurface(
      "the search form, which states no field of any decision and is read only for the tokens the result postback needs",
    ),
    listing: storedSourceSurface(CZ_NSS_RAW_PART.LISTING),
    detail: storedSourceSurface(CZ_NSS_RAW_PART.DETAIL),
    document: storedSourceSurface(CZ_NSS_RAW_PART.DOCUMENT),
    text: backlogSurface(
      ADAPTER_KEYS.CZ_NSS,
      "the plain-text rendering is fetched only where the rich document is absent, so the part is missing from every capture of a decision the portal served in full",
    ),
    original: backlogSurface(
      ADAPTER_KEYS.CZ_NSS,
      "the route for the publisher's own file answered a probe with a placeholder body, so whether it serves one is unsettled",
    ),
    export: excludedSourceSurface(
      "an export of a result list, scoped to the query that produced it rather than to a decision",
    ),
    "citation-copy": excludedSourceSurface(
      "a citation built from the result row's own cells",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

export const czNssAdapter = defineSourceAdapter({
  documentStage: "inline",
  key: ADAPTER_KEYS.CZ_NSS,
  sourceSurfaces: CZ_NSS_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: CZ_NSS_SOURCE_FIELD_DISPOSITIONS,
    listSourceFields: listCzNssSourceFields,
  },
  language: "cs",
  minRequestIntervalMs: 500,
  // Each page = 1 day = session + search + fulltext per decision.
  pageTimeoutMs: CZ_NSS_PAGE_TIMEOUT_MS,
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
        `31.12.${Temporal.Now.plainDateISO().year + 1}`,
      );

      const read = await readPublisher(`${BASE_URL}/Home/Index`, {
        fetchStage: "listing",
        adapterKey: ADAPTER_KEYS.CZ_NSS,
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
        refusalScope: "source",
      });

      if (read.type !== "present") {
        return read.type === "unavailable" && read.cause.kind === "thrown"
          ? { type: "probe-failed", errorTag: errorTag(read.cause.error) }
          : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }

      // A zero here is not a corpus of nothing; it is a search that did not
      // run, which `sourceTotalRead` refuses along with every other value a
      // total cannot be.
      const text = await readBodyText(read, signal);
      if (text.type !== "present") {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      const count = statedResultCount(text.value);
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
    // Publisher identity and content fields exclude listing position, query decoration, and repair aliases.
    revisionOf: (payload) =>
      isRecord(payload)
        ? {
            caseNumber: payload["caseNumber"],
            publishedCaseNumber: payload["publishedCaseNumber"],
            decisionDate: payload["decisionDate"],
            decisionType: payload["decisionType"],
            outcome: payload["outcome"],
            documentUrl: payload["documentUrl"],
            documentId: payload["documentId"],
          }
        : null,
    firstSlice: CZ_NSS_FIRST_SLICE,
    ...czNssDaySlices.walk,
    tipWindowDays: CZ_NSS_TIP_WINDOW_DAYS,
    // The reconciliation reads rows the crawl stored listing-only again.
    heldRequiresDetail: true,
    listSlicePage: listCzNssSlicePage,
    buildDecision: buildCzNssFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const readBudget = AbortSignal.timeout(CZ_NSS_PAGE_READ_BUDGET_MS);
        const effectiveSignal = signal
          ? AbortSignal.any([signal, readBudget])
          : readBudget;
        // The page's own budget ran out, as opposed to the caller's signal
        // (the cycle deadline or a cancellation), which fails the page.
        const readBudgetSpent = (): boolean =>
          readBudget.aborted && signal?.aborted !== true;

        const { date, page, missingCountAttempts = 0 } = parseCursor(cursor);
        const cursorFor = (nextDate: string, nextPage: number): string =>
          encodeCursor({
            date: nextDate,
            page: nextPage,
          });
        const today = todayIso();

        // If the date is in the future, park at today so we
        // only re-check today on the next cycle (never null —
        // null restarts from DEFAULT_LOOKBACK_DAYS ago).
        if (date > today) {
          return { decisions: [], nextCursor: cursorFor(today, 0) };
        }

        // 1. Get or reuse session
        const session = await getSession(effectiveSignal);

        // 2. Execute search for this date
        const searchRead = await executeSearch(session, date, effectiveSignal);
        if (searchRead.type === "missing-count") {
          invalidateSession();
          const attempts = missingCountAttempts + 1;
          if (attempts < CZ_NSS_MISSING_COUNT_ATTEMPTS) {
            logger.warn("case_law.ingestion.nss_count_retry", {
              adapterKey: ADAPTER_KEYS.CZ_NSS,
              date,
              page,
              attempts,
            });
            return {
              decisions: [],
              nextCursor: encodeCursor({
                date,
                page,
                missingCountAttempts: attempts,
              }),
            };
          }
          logger.warn("case_law.ingestion.nss_unsettled_day", {
            adapterKey: ADAPTER_KEYS.CZ_NSS,
            type: "missing-result-count",
            date,
            attempts,
            repair: "calendar_reconciliation",
          });
          const next = nextDay(date);
          return {
            decisions: [],
            itemBuildFailures: { type: "item_build_failed", count: 1 },
            nextCursor: encodeCursor({
              date: next <= today ? next : today,
              page: 0,
            }),
          };
        }
        const searchResult = requireSearchResult(searchRead);

        if (searchResult.type === "absent") {
          const rows = parseResultRows(searchResult.html);
          if (rows.length > 0) {
            throw new AdapterFetchError({
              message: `NSS stated no records for ${date} while rendering ${rows.length}`,
              adapterKey: ADAPTER_KEYS.CZ_NSS,
              cursor,
            });
          }
          const next = nextDay(date);
          return {
            decisions: [],
            nextCursor: cursorFor(next <= today ? next : today, 0),
          };
        }
        const { continuation } = searchResult;

        // Page 0 results are inline in the search response.
        const continued =
          page === 0
            ? null
            : await fetchResultPage({
                continuation,
                date,
                page,
                statedCount: searchResult.statedCount,
                session,
                signal: effectiveSignal,
              });
        if (continued !== null && !Result.isOk(continued)) {
          // Carried out as it stands: this whole body is the `try` of the
          // `Result.tryPromise` below, whose `catch` turns it into the `Err`
          // this adapter answers with. The cursor stays where it is and the
          // page is asked for again, rather than the day being settled on a
          // response the endpoint refused.
          const { error } = continued;
          throw error;
        }

        const rows = parseResultRows(
          continued === null ? searchResult.html : continued.value,
        );
        const expectedRows = czNssExpectedRows({
          page,
          statedCount: searchResult.statedCount,
        });
        const gap = Math.max(0, expectedRows - rows.length);
        if (gap > 0) {
          logger.warn("case_law.ingestion.nss_listing_gap", {
            adapterKey: ADAPTER_KEYS.CZ_NSS,
            date,
            page,
            type: "item_build_failed",
            count: gap,
            expectedRows,
            parsedRows: rows.length,
          });
        }
        const decisions: IngestionResult[] = [];
        let failed = gap;

        // Every listed row is stored, and the cursor moves past the page. A
        // document that was not read, including every row left once the
        // page's read budget is spent, is stored listing-only, and the
        // reconciliation reads it again.
        for (const row of rows) {
          const attempted = await buildPlainTextItem({
            decisionOf: (value) => value,
            adapterKey: ADAPTER_KEYS.CZ_NSS,

            rawListing: JSON.stringify(row),
            build: async () => {
              if (readBudgetSpent()) {
                return unreadRowDecision(row, null);
              }
              const built = await Result.tryPromise({
                try: async () =>
                  await buildCzNssDecision({
                    row,
                    session,
                    signal: effectiveSignal,
                  }),
                catch: (cause: unknown) => cause,
              });
              if (built.isOk()) {
                return built.value.decision;
              }
              if (
                readBudgetSpent() &&
                !(built.error instanceof PlainTextError)
              ) {
                return unreadRowDecision(row, null);
              }
              throw built.error;
            },
          });
          if (attempted.type === "item_build_failed") {
            failed++;
            decisions.push(attempted.decision);
            continue;
          }
          decisions.push(attempted.value);
        }

        // Parsed rows can be short because malformed rows were dropped. The
        // publisher's count still requires the remaining pages to be read.
        if (page + 1 < czNssTotalPages(searchResult.statedCount)) {
          // More pages for this date
          return {
            decisions,
            itemBuildFailures: { type: "item_build_failed", count: failed },
            nextCursor: cursorFor(date, page + 1),
          };
        }

        // No more pages; advance to next day
        const next = nextDay(date);
        return {
          decisions,
          itemBuildFailures: { type: "item_build_failed", count: failed },
          nextCursor: cursorFor(next <= today ? next : today, 0),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_NSS, cursor),
    });
  },
});
