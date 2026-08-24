import { panic } from "better-result";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifier } from "@stll/legal-ast/decision-identifier";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
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
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
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
 * Cursor format: item offset as string (e.g. "offset:100").
 */

const DUMP_URL = "https://www.saos.org.pl/api/dump/judgments";
const SEARCH_URL = "https://www.saos.org.pl/api/search/judgments";
const DETAIL_URL = "https://www.saos.org.pl/api/judgments";
const PUBLIC_JUDGMENT_URL = "https://www.saos.org.pl/judgments";
const PAGE_SIZE = 100;
const LEGACY_PAGE_SIZE = 100;
const ITEM_CONCURRENCY = 10;

/**
 * Judgments the slice listing asks the search endpoint for at a time, which
 * is half what the crawl asks the dump for.
 *
 * The dump serves an id-ordered window and is fast at 100. The search filters
 * by judgment date over the whole corpus and is not: on a date holding 149
 * judgments, its second page at 100 took a minute and then answered with the
 * publisher's maintenance page, while at 50 it answered JSON. The size the
 * crawl uses is therefore not the size this listing can use, so it is stated
 * separately rather than shared.
 */
export const PL_COURTS_SLICE_PAGE_SIZE = 50;

/**
 * How long the slice listing waits for one search page.
 *
 * Longer than {@link ADAPTER_TIMEOUT.LIST}, and for the same reason the crawl
 * gives its dump 60 s: a date-filtered search is a scan, and repeated
 * sampling of one 149-judgment date measured its later pages between 1 s and
 * 44 s. Aborting such a page raises a bare DOMException that holds the slice
 * for an hour, which is a worse answer than waiting for the one the publisher
 * is still producing.
 */
const SLICE_LIST_TIMEOUT_MS = 60_000;

/** What a listing answer must be, before it is read as one. */
const JSON_MEDIA_TYPE = "application/json";

/**
 * The media type a `Content-Type` names, without its parameters.
 *
 * Compared whole rather than searched for: `application/jsonp` contains the
 * JSON media type and is not it, and a parameter can carry the string into a
 * header that names something else entirely (`text/html; note=application/json`).
 */
const mediaTypeOf = (contentType: string): string =>
  (contentType.split(";").at(0) ?? "").trim().toLowerCase();

/**
 * SAOS numbers `pageNumber` from zero, on both the dump the crawl walks and
 * the search the slice listing walks: the listing asks for the slice's page
 * number unchanged, and the crawl derives the same number from its offset.
 */
const FIRST_PAGE = 0;

/** The only language this source publishes; half of the fallback identity. */
export const PL_COURTS_LANGUAGE = "pl";

/**
 * Earliest judgment date the publisher holds, and so the oldest slice the
 * historical sweep walks back to.
 *
 * Determined from the source itself: the search endpoint sorted
 * `JUDGMENT_DATE` ascending answers with the Constitutional Tribunal's first
 * rulings, of which `U 1/86` of this date is the earliest — the Tribunal began
 * adjudicating in 1986, so the corpus has nothing genuinely older. The single
 * row the sort puts ahead of it carries a mangled four-digit year and is a
 * publisher typo rather than a judgment from that year; the crawl still
 * ingests it, since `fetchPage` walks the dump in id order and never consults
 * a date.
 */
export const PL_COURTS_FIRST_SLICE = "1986-05-28";

/**
 * Slices near the tip the reconciliation re-walks on a fast cadence.
 *
 * A slice here is the judgment date, which is the only axis this API can
 * filter on, and not the date the publisher posted it. SAOS posts a judgment
 * long after it is handed down, and keeps posting against the same date for
 * more than a year: measured against the search endpoint's own result totals,
 * a fortnight of judgment dates held 1 judgment while it was the current
 * fortnight, 232 at four months old, and 667 at sixteen months old.
 *
 * So this window is not where the newest dates fill in, and no width would
 * make it so — the fill-in outlives any bounded window, and the loop re-walks
 * every tip slice daily, so a window sized to it would be a standing
 * re-survey rather than a fast lane. It is kept narrow for what it does do:
 * re-check the active frontier cheaply, over dates that are nearly empty.
 *
 * The consequence is worth stating plainly. A date walked while it is fresh
 * records `reported === collected` over almost nothing, which is not short, so
 * the ledger never re-selects it and later arrivals into that date are not
 * reconciled. Closing that needs a recheck cadence for settled slices, which
 * belongs to `reconciliation-plan.ts` and applies to every reconciled source,
 * not to this adapter. Until then the crawl remains the path that reaches a
 * late arrival at all: it walks the dump in id order, and a judgment posted
 * today takes a new id whatever date it carries.
 */
const PL_COURTS_TIP_WINDOW_DAYS = 14;

/**
 * Ordering for a slice listing. Database id ascending is the only ordering
 * this API offers that is stable under concurrent publication: ids are
 * assigned once and never move, so a judgment added between two page requests
 * appends past the last page instead of shifting every item onto a page the
 * walk has already read.
 */
const SLICE_SORTING_FIELD = "DATABASE_ID";
const SLICE_SORTING_DIRECTION = "ASC";

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
  /(?:^|[\s,])(?:z dnia\s+)?(?<day>\d{1,2})\s+(?<monthName>stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia)\s+(?<year>\d{4})\s*r?(?:oku)?\.?/iu;

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

/**
 * One judgment as SAOS states it. The dump, the search listing and the
 * per-judgment detail all answer with this shape; the listing endpoints simply
 * leave more of it out.
 */
export type SaosItem = {
  id?: number | null | undefined;
  href?: string | null | undefined;
  courtType?: string | null | undefined;
  courtCases?: SaosCourtCase[] | null | undefined;
  judgmentType?: string | null | undefined;
  judgmentDate?: string | null | undefined;
  judges?: SaosJudge[] | null | undefined;
  textContent?: string | null | undefined;
  keywords?: string[] | null | undefined;
  division?: SaosDivision | null | undefined;
  source?: SaosSource | null | undefined;
  ecli?: string | null | undefined;
  courtReporters?: string[] | null | undefined;
  decision?: string | null | undefined;
  summary?: string | null | undefined;
  legalBases?: string[] | null | undefined;
  referencedRegulations?: SaosReferencedRegulation[] | null | undefined;
  referencedCourtCases?: SaosReferencedCourtCase[] | null | undefined;
  receiptDate?: string | null | undefined;
  meansOfAppeal?: string | null | undefined;
  judgmentResult?: string | null | undefined;
  lowerCourtJudgments?: SaosCourtCase[] | null | undefined;
  dissentingOpinions?: unknown[] | null | undefined;
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

const validOrUndefined = <T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T | undefined => (guard(value) ? value : undefined);

/** Normalize one dump item without rejecting the page for a malformed field. */
export const normalizeSaosDumpItem = (
  value: Record<string, unknown>,
): SaosItem => ({
  id: validOrUndefined(value["id"], isNullishNumber),
  href: validOrUndefined(value["href"], isNullishString),
  courtType: validOrUndefined(value["courtType"], isNullishString),
  courtCases: validOrUndefined(value["courtCases"], (candidate) =>
    isNullishArrayOf(candidate, isSaosCourtCase),
  ),
  judgmentType: validOrUndefined(value["judgmentType"], isNullishString),
  judgmentDate: validOrUndefined(value["judgmentDate"], isNullishString),
  judges: validOrUndefined(value["judges"], (candidate) =>
    isNullishArrayOf(candidate, isSaosJudge),
  ),
  textContent: validOrUndefined(value["textContent"], isNullishString),
  keywords: validOrUndefined(value["keywords"], isOptionalStringArray),
  division: validOrUndefined(value["division"], (candidate) =>
    isNullishValue(candidate, isSaosDivision),
  ),
  source: validOrUndefined(value["source"], (candidate) =>
    isNullishValue(candidate, isSaosSource),
  ),
  ecli: validOrUndefined(value["ecli"], isNullishString),
  courtReporters: validOrUndefined(
    value["courtReporters"],
    isOptionalStringArray,
  ),
  decision: validOrUndefined(value["decision"], isNullishString),
  summary: validOrUndefined(value["summary"], isNullishString),
  legalBases: validOrUndefined(value["legalBases"], isOptionalStringArray),
  referencedRegulations: validOrUndefined(
    value["referencedRegulations"],
    (candidate) => isNullishArrayOf(candidate, isSaosReferencedRegulation),
  ),
  referencedCourtCases: validOrUndefined(
    value["referencedCourtCases"],
    (candidate) => isNullishArrayOf(candidate, isSaosReferencedCourtCase),
  ),
  receiptDate: validOrUndefined(value["receiptDate"], isNullishString),
  meansOfAppeal: validOrUndefined(value["meansOfAppeal"], isNullishString),
  judgmentResult: validOrUndefined(value["judgmentResult"], isNullishString),
  lowerCourtJudgments: validOrUndefined(
    value["lowerCourtJudgments"],
    (candidate) => isNullishArrayOf(candidate, isSaosCourtCase),
  ),
  dissentingOpinions: validOrUndefined(
    value["dissentingOpinions"],
    (candidate): candidate is unknown[] | null | undefined =>
      candidate === undefined || candidate === null || Array.isArray(candidate),
  ),
});

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
  const lines = text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    return trimmed ? [trimmed] : [];
  });

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
  const groups = POLISH_DATE_RE.exec(text)?.groups;
  const day = groups?.["day"]?.padStart(2, "0");
  const monthName = groups?.["monthName"]?.toLocaleLowerCase("pl-PL");
  const year = groups?.["year"];

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
  if (raw && /^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
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
    response = await fetchWithTimeout(`${DETAIL_URL}/${id}`, {
      signal,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
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

const normalizeOptionalArray = <T>(
  primary: T[] | null | undefined,
  fallback?: T[] | null,
): T[] => {
  if (primary) {
    return primary;
  }
  if (fallback) {
    return fallback;
  }
  return [];
};

/**
 * The publisher's own document id for an item, or undefined where the item
 * carries none.
 *
 * Stated here rather than at each use so the crawl and the reconciliation
 * cannot key a decision differently. Returning undefined for a missing id is
 * the point: stringifying it would key every id-less item on the same literal
 * `"undefined"` and collapse them onto one row.
 */
export const plCourtsSourceDocumentId = (
  id: number | null | undefined,
): string | undefined => {
  if (id === undefined || id === null || !Number.isInteger(id)) {
    return undefined;
  }
  const candidate = String(id);
  return isPersistableSourceDocumentId(candidate) ? candidate : undefined;
};

type PrimaryCaseNumberOptions = {
  /** The record to read first; the detail where one was fetched. */
  preferred: SaosItem;
  /** Consulted only where the preferred record states no docket. */
  fallback?: SaosItem | undefined;
};

/** The docket this source keys a decision on, preferring the richer record. */
const primaryCaseNumber = ({
  preferred,
  fallback,
}: PrimaryCaseNumberOptions): string | undefined =>
  toOptionalValue(
    (
      preferred.courtCases?.find((courtCase) => courtCase.caseNumber) ??
      fallback?.courtCases?.find((courtCase) => courtCase.caseNumber)
    )?.caseNumber,
  );

/**
 * The identity the ingest would store for this listing item.
 *
 * Stated once, here, rather than restated by every caller that has to decide
 * whether a listed item is already held: the crawl and the reconciliation loop
 * key rows the same way, and a second copy of the rule would let them disagree
 * about which rows exist. Both halves are the same expressions the build path
 * uses, so the two cannot drift apart.
 */
export const plCourtsListingIdentity = (item: SaosItem): ListingIdentity => {
  const sourceDocumentId = plCourtsSourceDocumentId(item.id);
  if (sourceDocumentId !== undefined) {
    return { type: "document", sourceDocumentId };
  }
  const caseNumber = primaryCaseNumber({ preferred: item });
  if (caseNumber === undefined) {
    return { type: "unidentifiable" };
  }
  return {
    type: "case-number",
    caseNumber,
    language: PL_COURTS_LANGUAGE,
  };
};

/**
 * What asking the per-judgment endpoint about a listed item produced.
 *
 * `listing-only` and `unavailable` are kept apart on purpose. The crawl treats
 * both as "no detail" and stores the listing observation either way, which is
 * right for a page that must keep moving. A caller filling gaps needs the
 * difference: storing a detail-less row would make the identity held and take
 * the document out of every later reconciliation, so a fetch that returned
 * nothing has to be reported rather than folded into the decision.
 */
type PlCourtsDetailFetch =
  | { type: "detail"; detail: SaosItem }
  /** The item carries no id, so there is no detail record to ask for. */
  | { type: "listing-only" }
  /** An id was asked about and nothing came back. */
  | { type: "unavailable" };

const fetchDetailForItem = async (
  item: SaosItem,
  signal?: AbortSignal,
): Promise<PlCourtsDetailFetch> => {
  const id = item.id;
  if (id === undefined || id === null) {
    return { type: "listing-only" };
  }
  const detail = await fetchDetail(id, signal);
  return detail === null ? { type: "unavailable" } : { type: "detail", detail };
};

type BuildPlDecisionOptions = {
  /** The item exactly as the publisher listed it. */
  listingItem: SaosItem;
  /** The per-judgment record, where one was read. */
  detail: SaosItem | null;
};

/**
 * Build one decision from a listing item and whatever detail was read for it.
 *
 * Export-only refactor of what the crawl page already did, kept as one
 * function so the listing walk and the crawl cannot parse or enrich
 * differently.
 */
const buildPlDecision = ({
  listingItem,
  detail,
}: BuildPlDecisionOptions): IngestionResult | null => {
  // SAFETY: All SaosItem fields are optional/nullable. The function
  // accesses them with optional chaining and null checks throughout.
  // Full isSaosItem validation was moved out of the hot path because
  // a single unexpected field type (e.g. dissentingOpinions as object)
  // would reject the entire page, blocking all ingestion.
  // Aliased rather than renamed throughout: the body below reads the listing
  // half under this name in some sixty places, none of which changed.
  const dumpItem = listingItem;
  const item = detail ?? dumpItem;

  const caseNumber = primaryCaseNumber({ preferred: item, fallback: dumpItem });
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
  const keywords = normalizeOptionalArray(item.keywords, dumpItem.keywords);
  const statutes = normalizeOptionalArray(item.legalBases, dumpItem.legalBases);
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
  const courtReporters = normalizeOptionalArray(
    item.courtReporters,
    dumpItem.courtReporters,
  );
  const reporterIdentifiers: DecisionIdentifier[] = courtReporters.map(
    (value) => ({
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value,
    }),
  );
  const publisherIdentifiers: DecisionIdentifier[] = additionalCaseNumbers
    ? [
        ...additionalCaseNumbers.map((value) => ({
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value,
        })),
        ...reporterIdentifiers,
      ]
    : reporterIdentifiers;
  const [firstPublisherIdentifier, ...otherPublisherIdentifiers] =
    publisherIdentifiers;

  const rawPayload = JSON.stringify({ dumpItem, detail });
  const rawHash = hashContent(JSON.stringify(dumpItem));

  const publisherCitedCases = normalizeOptionalArray(
    item.referencedCourtCases,
    dumpItem.referencedCourtCases,
  )
    .map((referenced) => referenced.caseNumber?.trim() ?? "")
    .filter((caseNo) => caseNo.length > 0);

  return {
    caseNumber,
    ecli,
    ...(firstPublisherIdentifier === undefined
      ? {}
      : {
          identifiers: [firstPublisherIdentifier, ...otherPublisherIdentifiers],
        }),
    court: courtName,
    country: "POL",
    language: "pl",
    decisionDate,
    decisionType,
    fulltext,
    sourceDocumentId: plCourtsSourceDocumentId(item.id ?? dumpItem.id),
    sourceUrl: publicSourceUrl(item.id ?? dumpItem.id),
    documentUrl,
    publisherCitedCases,
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
        specialRoles: normalizeOptionalArray(judge.specialRoles),
      })),
      keywords,
      division: effectiveDivision,
      source: effectiveSource,
      courtReporters,
      decision: toOptionalValue(item.decision ?? dumpItem.decision),
      summary: toOptionalValue(item.summary ?? dumpItem.summary),
      legalBases: statutes,
      referencedRegulations: normalizeOptionalArray(
        item.referencedRegulations,
        dumpItem.referencedRegulations,
      ),
      referencedCourtCases: normalizeOptionalArray(
        item.referencedCourtCases,
        dumpItem.referencedCourtCases,
      ),
      receiptDate: toOptionalValue(item.receiptDate ?? dumpItem.receiptDate),
      meansOfAppeal: toOptionalValue(
        item.meansOfAppeal ?? dumpItem.meansOfAppeal,
      ),
      judgmentResult: toOptionalValue(
        item.judgmentResult ?? dumpItem.judgmentResult,
      ),
      lowerCourtJudgments: normalizeOptionalArray(
        item.lowerCourtJudgments,
        dumpItem.lowerCourtJudgments,
      ),
      dissentingOpinions: normalizeDissentingOpinions(
        normalizeOptionalArray(
          item.dissentingOpinions,
          dumpItem.dissentingOpinions,
        ),
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

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  if (!isRecord(raw)) {
    return null;
  }

  const listingItem = normalizeSaosDumpItem(raw);
  const fetched = await fetchDetailForItem(listingItem, signal);
  return buildPlDecision({
    listingItem,
    detail: fetched.type === "detail" ? fetched.detail : null,
  });
};

/**
 * A reconciliation slice for this source is one judgment date, which is what
 * the search endpoint's `judgmentDateFrom`/`judgmentDateTo` pair addresses
 * — the API states both as `yyyy-MM-dd` in its own query template, and a
 * filtered listing answers only with judgments carrying that date.
 * `YYYY-MM-DD` sorts lexicographically in chronological order, which is the
 * ordering the ledger relies on.
 */
const plCourtsDaySlices = createCalendarDaySliceWalk({
  firstSlice: PL_COURTS_FIRST_SLICE,
  source: ADAPTER_KEYS.PL_COURTS,
});

/** The search endpoint's answer, read only for what a slice walk needs. */
type SaosSliceResponse = {
  items?: Record<string, unknown>[] | null;
  info?: { totalResults?: number | null } | null;
};

const isSaosSliceResponse = (value: unknown): value is SaosSliceResponse =>
  isRecord(value) &&
  isNullishArrayOf(value["items"], isRecord) &&
  isSaosSearchResponse(value);

type ListPlCourtsDayPageOptions = {
  /** Judgment date, `YYYY-MM-DD`. */
  date: string;
  /** 0-indexed page within the day. */
  page: number;
  signal?: AbortSignal | undefined;
};

export type PlCourtsDayPage = {
  items: SaosItem[];
  /** 0 for a day the publisher lists no judgment for. */
  totalPages: number;
};

/**
 * One page of the publisher's own listing for a judgment date.
 *
 * The crawl reaches a judgment by walking the dump forward in id order and
 * pays a detail fetch for every item on the page, which is the wrong shape for
 * asking what a date contains. This is the same politeness, the same payload
 * normalization and the same identity rule, stopping at the listing.
 *
 * The page count is derived from the filtered result total rather than read
 * from the response, which states no page count. A payload without that total
 * is refused rather than reported as a short day: an undercounted `reported`
 * reads to the ledger as a fully collected slice.
 */
export const listPlCourtsDayPage = async ({
  date,
  page,
  signal,
}: ListPlCourtsDayPageOptions): Promise<PlCourtsDayPage> => {
  const url = `${SEARCH_URL}?${new URLSearchParams({
    pageSize: String(PL_COURTS_SLICE_PAGE_SIZE),
    pageNumber: String(page + FIRST_PAGE),
    sortingField: SLICE_SORTING_FIELD,
    sortingDirection: SLICE_SORTING_DIRECTION,
    judgmentDateFrom: date,
    judgmentDateTo: date,
  }).toString()}`;

  const response = await fetchWithTimeout(url, {
    signal,
    timeoutMs: SLICE_LIST_TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      "User-Agent": INGESTION_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `SAOS search API error: ${response.status}`,
      adapterKey: ADAPTER_KEYS.PL_COURTS,
      cursor: date,
      httpStatus: response.status,
    });
  }

  // The publisher answers a 200 carrying an HTML maintenance page when the
  // search is under load, and `response.json()` meets that with a raw
  // SyntaxError: no adapter, no cursor, nothing naming the publisher as the
  // cause. Refused here instead, as the tagged failure every other answer
  // this function will not read is.
  const mediaType = mediaTypeOf(response.headers.get("content-type") ?? "");
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new AdapterFetchError({
      message: `SAOS search API answered ${mediaType.length === 0 ? "no content type" : mediaType} rather than ${JSON_MEDIA_TYPE}`,
      adapterKey: ADAPTER_KEYS.PL_COURTS,
      cursor: date,
      httpStatus: response.status,
    });
  }

  const json: unknown = await response.json();
  if (!isSaosSliceResponse(json)) {
    throw new AdapterFetchError({
      message: "SAOS search API returned an invalid payload",
      adapterKey: ADAPTER_KEYS.PL_COURTS,
      cursor: date,
    });
  }

  const totalResults = json.info?.totalResults;
  if (totalResults === undefined || totalResults === null) {
    throw new AdapterFetchError({
      message: "SAOS search API stated no result total for the slice",
      adapterKey: ADAPTER_KEYS.PL_COURTS,
      cursor: date,
    });
  }

  const items = normalizeOptionalArray(json.items).map(normalizeSaosDumpItem);
  const totalPages = Math.ceil(totalResults / PL_COURTS_SLICE_PAGE_SIZE);

  // A page the publisher's own total says holds judgments has to return them.
  // Checked against the total rather than against the key's presence, because
  // an omitted `items` and an empty one do the same damage and only this
  // catches both: the walk would read the page as a date with nothing on it,
  // record `reported` from the identities it saw instead of the ones the
  // publisher counted, and leave a historical slice looking fully collected
  // and never worth re-selecting. Refused rather than truncated, exactly as an
  // over-long listing is: the slice keeps its previous ledger row and the
  // failure surfaces in the loop's tally.
  if (items.length === 0 && page < totalPages) {
    throw new AdapterFetchError({
      message: `SAOS search API returned no judgments on page ${page} of ${totalPages} for the slice`,
      adapterKey: ADAPTER_KEYS.PL_COURTS,
      cursor: date,
    });
  }

  return { items, totalPages };
};

const listPlCourtsSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const { items, totalPages } = await listPlCourtsDayPage({
    date: slice,
    page,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    items: items.map((item) => ({
      identity: plCourtsListingIdentity(item),
      payload: item,
    })),
    totalPages,
  };
};

/**
 * Rebuild a decision from a payload the loop stored verbatim.
 *
 * The payload is renormalized rather than trusted: it may have been parked for
 * days, and a shape the adapter no longer recognises has to be reported as
 * unbuildable instead of parsed on faith.
 */
const buildPlCourtsFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const listingItem = normalizeSaosDumpItem(payload);
  const fetched = await fetchDetailForItem(listingItem, signal);
  switch (fetched.type) {
    case "unavailable":
      return { type: "detail-unavailable" };
    case "listing-only":
    case "detail": {
      const decision = buildPlDecision({
        listingItem,
        detail: fetched.type === "detail" ? fetched.detail : null,
      });
      return decision === null
        ? { type: "unkeyable" }
        : { type: "built", decision };
    }
    default: {
      const exhaustive: never = fetched;
      return panic(
        `Unhandled pl-courts detail fetch: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
};

export const plCourtsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_COURTS,
  name: "Polish Courts (SAOS)",
  country: "POL",
  language: "pl",
  minRequestIntervalMs: 200,
  pageTimeoutMs: 280_000,
  maxCycleMs: 30 * 60 * 1000,

  async getTotalCount(signal) {
    try {
      const response = await fetchWithTimeout(
        `${SEARCH_URL}?${new URLSearchParams({
          pageSize: "1",
          pageNumber: String(FIRST_PAGE),
          sortingField: "JUDGMENT_DATE",
          sortingDirection: "DESC",
        }).toString()}`,
        {
          signal,
          timeoutMs: ADAPTER_TIMEOUT.LIST,
          headers: {
            Accept: "application/json",
            "User-Agent": INGESTION_USER_AGENT,
          },
        },
      );

      if (!response.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }

      const json: unknown = await response.json();
      if (!isSaosSearchResponse(json)) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }

      const total = toOptionalValue(json.info?.totalResults);
      return total === undefined
        ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
        : sourceTotalRead(total);
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  /**
   * The publisher lists each judgment date independently of the crawl's dump
   * cursor, so what a date contains is answerable without re-crawling it:
   * enumerate the date, key each item the way the ingest would, and compare
   * against what is held.
   */
  reconciliation: {
    firstSlice: PL_COURTS_FIRST_SLICE,
    ...plCourtsDaySlices.walk,
    tipWindowDays: PL_COURTS_TIP_WINDOW_DAYS,
    listSlicePage: listPlCourtsSlicePage,
    buildDecision: buildPlCourtsFromPayload,
  },

  fetchPage: createPagePaginatedFetch<SaosDumpResponse>({
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    pageSize: PAGE_SIZE,
    legacyPageSize: LEGACY_PAGE_SIZE,
    firstPage: FIRST_PAGE,
    listTimeoutMs: 60_000,
    itemConcurrency: ITEM_CONCURRENCY,

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
      items: normalizeOptionalArray(data.items),
    }),

    parseItem: parseItemWithDetail,
  }),
});
