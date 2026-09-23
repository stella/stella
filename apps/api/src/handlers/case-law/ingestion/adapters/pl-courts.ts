import { panic, Result } from "better-result";
import * as v from "valibot";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifier } from "@stll/legal-ast/decision-identifier";
import { parsePlainDate, Temporal } from "@stll/time";

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
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  EmptyAst,
  IngestionItem,
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
import {
  createPagePaginatedFetch,
  defineWalkKind,
} from "@/api/handlers/case-law/ingestion/adapters/pagination";
import type { WalkKind } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import { fetchPublisher } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  hashContent,
  INGESTION_USER_AGENT,
  isArrayOf,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  stripHtml,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
  sourceTextField,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";
import { logger } from "@/api/lib/observability/logger";
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
 * How the dump is walked is policy, and the adapter holds only the vocabulary
 * it can be asked for: see {@link PL_COURTS_WALK_KINDS}. A source that states
 * no walks is crawled the plain way, as one offset walk over the unfiltered
 * dump.
 *
 * Where walks are configured, a walk ends when the publisher answers a page
 * short of the page size, and the helper hands over to the next walk in the
 * list; the last one names itself, so it restarts from its own head each time
 * it runs dry.
 *
 * Cursor format: `<walk>:<item offset>` (e.g. "m-2014-03:1200"). A cursor
 * naming a walk the current policy does not declare, including a plain
 * offset cursor ("offset:1927900"), restarts at the first walk.
 */

const DUMP_URL = "https://www.saos.org.pl/api/dump/judgments";
const SEARCH_URL = "https://www.saos.org.pl/api/search/judgments";
const DETAIL_URL = "https://www.saos.org.pl/api/judgments";
const PUBLIC_JUDGMENT_URL = "https://www.saos.org.pl/judgments";

/**
 * The envelope part each response this adapter reads is kept under.
 *
 * The two listings are kept apart rather than folded into one part: a
 * decision is named by the dump or by the date-filtered search, never by
 * both, and the two rows state different halves of the same object. One part
 * holding either would leave a reader unable to say which listing it has.
 */
const RAW_PART = {
  LISTING_DUMP: "listing-dump",
  LISTING_SEARCH: "listing-search",
  DETAIL: "detail",
} as const;
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
 * publisher typo rather than a judgment from that year, which is why the
 * date-window walk leaves either bound omittable.
 */
export const PL_COURTS_FIRST_SLICE =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_COURTS].dateRange.fromInclusive;

const dumpRequest = (
  page: number,
  filters: Record<string, string>,
): { url: string; init: RequestInit } => ({
  url: `${DUMP_URL}?${new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    pageNumber: String(page),
    withGenerated: "true",
    ...filters,
  }).toString()}`,
  init: { headers: { Accept: JSON_MEDIA_TYPE } },
});

/** The walk kinds a source's configuration may ask this adapter for. */
export const PL_COURTS_WALK_KIND = {
  JUDGMENT_DATE: "judgment-date",
  SINCE_MODIFIED: "since-modified",
  WHOLE_DUMP: "whole-dump",
} as const;

type PlCourtsWalkKind =
  (typeof PL_COURTS_WALK_KIND)[keyof typeof PL_COURTS_WALK_KIND];

/**
 * The date a since-modified walk asks the publisher to list changes from.
 *
 * Taken from a calendar day rather than an instant so the request is stable
 * for the whole day and the walk cannot ask for a narrower window each time
 * it restarts.
 */
export const plCourtsModifiedSince = (
  today: Temporal.PlainDate,
  lookbackDays: number,
): string =>
  `${today.subtract({ days: lookbackDays }).toString()}T00:00:00.000`;

/**
 * The walks this adapter knows how to make over the dump, and what each takes.
 *
 * The dump is a single collection of several hundred thousand judgments with
 * no end the walker can recognise from inside it, so one offset walk over the
 * whole thing is unbounded: every event that advances the cursor without
 * reading a page (a timeout, a publisher-side 5xx) pushes it further past the
 * tail, where each request costs seconds and answers with nothing. The
 * filtered kinds below bound a walk instead. A bounded walk's last page is
 * short, which is the signal the pagination helper hands over on, so a walk
 * that runs out of judgments moves to the next one rather than deeper into
 * empty offsets.
 *
 * Which walks are made, in what order, and over which windows is policy and
 * arrives in the source's configuration. A walk's name is persisted as a
 * cursor prefix, so a policy whose names move renames its own cursors and
 * restarts the crawl: names are stable input, never derived from the date the
 * policy is read on.
 */
export const PL_COURTS_WALK_KINDS = {
  /**
   * A window of the dump bounded by judgment date. Either bound may be
   * omitted, which leaves that side open.
   *
   * `judgmentDate` is publisher data and a few records carry years no
   * judgment can hold, in both directions, so a policy meaning to reach every
   * record needs open ends: no date then puts a judgment outside every window.
   */
  [PL_COURTS_WALK_KIND.JUDGMENT_DATE]: defineWalkKind({
    params: {
      from: v.optional(v.pipe(v.string(), v.isoDate())),
      to: v.optional(v.pipe(v.string(), v.isoDate())),
    },
    /**
     * A window that ends before it starts holds no date, so the publisher
     * answers its first page empty — which is exactly how a walk says it is
     * finished. The walk would hand over on its first request every cycle and
     * look like a walk that had done its work, so the reversal has to be
     * refused where it is still visible as one. ISO dates order
     * lexicographically, so the comparison is the string one.
     */
    objection: ({ from, to }) =>
      from !== undefined && to !== undefined && from > to
        ? `states a judgment-date window from ${from} back to ${to}`
        : null,
    buildRequest:
      ({ from, to }) =>
      (page) =>
        dumpRequest(page, {
          ...(from === undefined ? {} : { judgmentStartDate: from }),
          ...(to === undefined ? {} : { judgmentEndDate: to }),
        }),
  }),

  /**
   * Everything the publisher has edited within the lookback, whatever
   * judgment date it carries.
   *
   * This is the shape a crawl stays current in: a judgment edited while a
   * date-bounded walk was elsewhere is listed again here. A lookback wider
   * than one full pass over the configured walks is what keeps such an edit
   * from falling between two visits.
   */
  [PL_COURTS_WALK_KIND.SINCE_MODIFIED]: defineWalkKind({
    params: { lookbackDays: v.pipe(v.number(), v.integer(), v.minValue(1)) },
    buildRequest:
      ({ lookbackDays }) =>
      (page) =>
        dumpRequest(page, {
          // Read per page, so a lap that crosses UTC midnight asks the later
          // pages for a window one day narrower. Dropping that oldest day
          // shortens the filtered collection from its front, which slides
          // later judgments to lower offsets, and one can land behind the
          // offset the lap has reached. It is a delay, not a loss: the item
          // stays in the window for the rest of the lookback, which is days,
          // and every entry into this walk is at offset 0 — it names itself
          // as its successor, so running dry restarts it at its own head, and
          // a checkpoint only ever persists that. The next lap reads it.
          sinceModificationDate: plCourtsModifiedSince(
            Temporal.Now.plainDateISO("UTC"),
            lookbackDays,
          ),
        }),
  }),

  /** The dump unfiltered, in the publisher's own order: the plain walk. */
  [PL_COURTS_WALK_KIND.WHOLE_DUMP]: defineWalkKind({
    params: {},
    buildRequest: () => (page) => dumpRequest(page, {}),
  }),
} as const satisfies Record<PlCourtsWalkKind, WalkKind>;

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

/**
 * The court a `courtType` names, for a record stating no court of its own.
 *
 * Four entries for the four tiers this aggregator holds. `ADMINISTRATIVE` is
 * a fifth value its schema declares and no record carries, so naming a court
 * for it would be this file inventing one.
 */
const COURT_TYPE_MAP: Record<string, string> = {
  COMMON: "Sąd powszechny",
  SUPREME: "Sąd Najwyższy",
  CONSTITUTIONAL_TRIBUNAL: "Trybunał Konstytucyjny",
  NATIONAL_APPEAL_CHAMBER: "Krajowa Izba Odwoławcza",
};

/** SAOS's `judgmentType` enum, and the local term each is stored under. */
const SAOS_JUDGMENT_TYPE = {
  SENTENCE: "wyrok",
  DECISION: "postanowienie",
  RESOLUTION: "uchwała",
  REASONS: "uzasadnienie",
  REGULATION: "zarządzenie",
} as const;

const JUDGMENT_TYPE_MAP: Record<string, string> = SAOS_JUDGMENT_TYPE;

/**
 * The `judgmentType` SAOS gives the written reasons of a ruling when it
 * publishes them apart from it, as a document with an id of its own.
 */
const SAOS_REASONS_JUDGMENT_TYPE =
  "REASONS" satisfies keyof typeof SAOS_JUDGMENT_TYPE;

/**
 * The rulings written reasons can belong to. A `zarządzenie` is an order of
 * the presiding judge and carries no reasons of its own.
 */
export const PL_COURTS_RULING_DECISION_TYPES = [
  SAOS_JUDGMENT_TYPE.SENTENCE,
  SAOS_JUDGMENT_TYPE.DECISION,
  SAOS_JUDGMENT_TYPE.RESOLUTION,
] as const;

/**
 * The decision type a reasons document is stored under while the corpus
 * holds no ruling it belongs to: reasons published without the operative
 * part ("sentencja") they explain. Not `uzasadnienie`, which reads as a kind
 * of ruling beside `wyrok` and `postanowienie`; the row is the reasons of a
 * ruling this corpus does not hold.
 */
export const PL_COURTS_STANDALONE_REASONS_DECISION_TYPE =
  "uzasadnienie bez sentencji";

/**
 * The type every reasons document was stored under while this adapter wrote
 * them as decisions; what the supplement fold selects to fold.
 */
export const PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE =
  SAOS_JUDGMENT_TYPE.REASONS;

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

type SaosChamber = {
  href?: string | null;
  id?: number | null;
  name?: string | null;
};

/**
 * The form the publisher prints for a decision.
 *
 * Two shapes for one field: the search listing states it as a string and the
 * per-judgment record as an object. A reader that took one would drop the
 * field on half the payloads that state it.
 */
type SaosJudgmentForm = string | { name?: string | null };

/** One separate opinion as the publisher states it. */
type SaosDissentingOpinion = {
  textContent?: string | null;
  authors?: string[] | null;
};

/** The same opinion once read: its text, and the judges who signed it. */
type PlDissentingOpinion = {
  textContent: string;
  authors: string[];
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
  chambers?: SaosChamber[] | null | undefined;
  personnelType?: string | null | undefined;
  judgmentForm?: SaosJudgmentForm | null | undefined;
  source?: SaosSource | null | undefined;
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

/** A dump answer the crawl will read: `items` stated, whatever it holds. */
type SaosDumpPage = SaosDumpResponse & { items: SaosItem[] };

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

const isSaosChamber = (value: unknown): value is SaosChamber =>
  isRecord(value) &&
  isNullishNumber(value["id"]) &&
  isNullishString(value["href"]) &&
  isNullishString(value["name"]);

const isNullishJudgmentForm = (
  value: unknown,
): value is SaosJudgmentForm | null | undefined =>
  value === undefined ||
  value === null ||
  typeof value === "string" ||
  (isRecord(value) && isNullishString(value["name"]));

const isSaosDissentingOpinion = (
  value: unknown,
): value is SaosDissentingOpinion =>
  isRecord(value) &&
  isNullishString(value["textContent"]) &&
  isOptionalStringArray(value["authors"]);

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
  isNullishArrayOf(value["chambers"], isSaosChamber) &&
  isNullishString(value["personnelType"]) &&
  isNullishJudgmentForm(value["judgmentForm"]) &&
  isNullishValue(value["source"], isSaosSource) &&
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

/**
 * Normalize one listed item without rejecting the page for a malformed field.
 *
 * The result is what the build path reads. It is not what a replay reads:
 * the response this item came from is kept verbatim as its own envelope
 * part, so a field this function has no name for is still recoverable from
 * the stored row rather than only by crawling the publisher again.
 */
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
  chambers: validOrUndefined(value["chambers"], (candidate) =>
    isNullishArrayOf(candidate, isSaosChamber),
  ),
  personnelType: validOrUndefined(value["personnelType"], isNullishString),
  judgmentForm: validOrUndefined(value["judgmentForm"], isNullishJudgmentForm),
  source: validOrUndefined(value["source"], (candidate) =>
    isNullishValue(candidate, isSaosSource),
  ),
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

/**
 * A page of the dump, as opposed to anything else the endpoint may answer
 * with under a 200.
 *
 * `items` has to be present and an array. Reading a payload that lacks it
 * as a page of no judgments is what makes a malformed answer dangerous
 * here: an empty page is the signal a date shard is finished, so one such
 * answer would hand the walk to the next shard and leave the rest of the
 * current one unread until a later sweep.
 */
const isSaosDumpPage = (value: unknown): value is SaosDumpPage =>
  isRecord(value) && isArrayOf(value["items"], isRecord);

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

/**
 * The years a decision this source publishes can carry.
 *
 * `judgmentDate` is publisher data and some records state a year no judgment
 * can hold — `0208-03-14` for a decision handed down in 2018. The bound is
 * what separates such a typo from a date, and the same bound applies to the
 * date read out of the publisher's own document id.
 */
const isDatableYear = (date: Temporal.PlainDate): boolean =>
  date.year >= 1900 && date.year <= Temporal.Now.plainDateISO().year + 1;

const ISO_DATE_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The judgment date carried by the deciding court's own id for the document.
 *
 * A common-court `source.judgmentId` is that court's file signature, and its
 * last-but-one segment is the date it filed the document under
 * (`…_Uz_2018-03-22_001`). Read from the back, so a signature carrying an
 * earlier date-shaped segment still answers with its own.
 */
const upstreamIdDate = (judgmentId: string | undefined): string | undefined => {
  if (judgmentId === undefined) {
    return undefined;
  }
  const segments = judgmentId.split("_");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined || !ISO_DATE_SEGMENT_RE.test(segment)) {
      continue;
    }
    const parsed = parsePlainDate(segment);
    if (parsed !== null && isDatableYear(parsed)) {
      return parsed.toString();
    }
  }
  return undefined;
};

/** Emitted where no payload this source serves states a usable date. */
const DECISION_DATE_UNREADABLE = "case_law.ingestion.decision_date_unreadable";

type DecisionDateOptions = {
  /** `judgmentDate`, as the aggregator states it. */
  stated: string | null | undefined;
  /** `source.judgmentId`: the deciding court's own id for the document. */
  upstreamId: string | undefined;
  /** The aggregator's id, so a refused date names its record in the log. */
  saosId: number | null | undefined;
};

/**
 * The decision's date, or nothing.
 *
 * Two readings and no third. The aggregator's `judgmentDate` where it holds a
 * year a judgment can carry, then the date inside the deciding court's own
 * document id, which is that court's statement of the same fact. A date
 * scanned out of the document's prose is not a third reading: a Polish
 * judgment opens by reciting the dates the case is about, so that scan
 * returns the date of a loan agreement as readily as the date of the
 * judgment, and a confident wrong date is worse than an absent one.
 */
const normalizeDecisionDate = ({
  stated,
  upstreamId,
  saosId,
}: DecisionDateOptions): string | undefined => {
  const statedDate = stated ? parsePlainDate(stated) : null;
  if (statedDate !== null && isDatableYear(statedDate)) {
    return statedDate.toString();
  }

  const fromUpstreamId = upstreamIdDate(upstreamId);
  if (fromUpstreamId !== undefined) {
    return fromUpstreamId;
  }

  logger.warn(DECISION_DATE_UNREADABLE, {
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    statedDate: stated ?? "",
    ...(typeof saosId === "number" ? { saosId } : {}),
  });
  return undefined;
};

/**
 * A per-judgment record, and the response it was read from.
 *
 * The payload travels with the parsed record because the envelope keeps the
 * response the publisher served, not this adapter's reading of it: a field
 * nothing here has a name for yet is then still in the stored row.
 */
type SaosDetailFetch = {
  item: SaosItem;
  payload: string;
};

const fetchDetail = async (
  id: number,
  signal?: AbortSignal,
): Promise<SaosDetailFetch | null> => {
  let response: Response;
  try {
    response = await fetchPublisher(`${DETAIL_URL}/${id}`, {
      adapterKey: ADAPTER_KEYS.PL_COURTS,
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

  let payload: string;
  try {
    payload = await response.text();
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return null;
  }
  const json = Result.try((): unknown => JSON.parse(payload)).unwrapOr(null);
  if (!isSaosDetailResponse(json)) {
    return null;
  }

  const item = json.data;
  return item === undefined || item === null ? null : { item, payload };
};

const publicSourceUrl = (id: number | null | undefined): string | undefined =>
  id !== undefined && id !== null ? `${PUBLIC_JUDGMENT_URL}/${id}` : undefined;

/**
 * The separate opinions of one decision, text and signatories both.
 *
 * This source states an opinion as a bare string on older records and as an
 * object on the rest, and only the object names who wrote it. The authors are
 * the half that matters twice: they are metadata about the opinion and they
 * are judges of the decision, so dropping them lost a role no other field
 * states.
 */
const normalizeDissentingOpinions = (
  opinions: unknown[] | null | undefined,
): PlDissentingOpinion[] => {
  if (!opinions) {
    return [];
  }
  const result: PlDissentingOpinion[] = [];
  for (const opinion of opinions) {
    if (typeof opinion === "string") {
      result.push({ textContent: opinion, authors: [] });
      continue;
    }
    if (!isSaosDissentingOpinion(opinion)) {
      // A shape no reader here names, left to the stored response.
      continue;
    }
    result.push({
      textContent: toOptionalValue(opinion.textContent) ?? "",
      authors: normalizeOptionalArray(opinion.authors),
    });
  }
  return result;
};

/**
 * The special roles this source marks a bench member with.
 *
 * `REASONS_FOR_JUDGMENT_AUTHOR` is a fourth value it states and no role of
 * its own: it marks who wrote the reasons, which every record that carries it
 * also states as the reporting judge.
 */
const SAOS_JUDGE_ROLE = {
  PRESIDING: "PRESIDING_JUDGE",
  REPORTING: "REPORTING_JUDGE",
} as const;

/**
 * The role one bench member is named in.
 *
 * Reporting outranks presiding where a record states both: the rapporteur is
 * what a reader of the decision is looking for, and a judge is listed once.
 * A member with no role stated sat on the bench, which is itself a fact the
 * row could not carry before.
 */
const benchRole = (judge: SaosJudge): DecisionJudgeInput["role"] => {
  const roles = normalizeOptionalArray(judge.specialRoles);
  if (roles.includes(SAOS_JUDGE_ROLE.REPORTING)) {
    return DECISION_JUDGE_ROLE.RAPPORTEUR;
  }
  return roles.includes(SAOS_JUDGE_ROLE.PRESIDING)
    ? DECISION_JUDGE_ROLE.PRESIDING
    : DECISION_JUDGE_ROLE.PANEL_MEMBER;
};

type DecisionJudgesOptions = {
  judges: readonly SaosJudge[];
  dissentingOpinions: readonly PlDissentingOpinion[];
};

/**
 * The judges a decision names, in the roles it names them in.
 *
 * Names are taken as printed: this source prints the bare name and carries
 * the honorific in `function`, so there is nothing to strip. A dissent's
 * author is emitted beside their seat on the bench rather than instead of
 * it — both are true of the same judge, and the two rows key differently.
 */
const decisionJudges = ({
  judges,
  dissentingOpinions,
}: DecisionJudgesOptions): DecisionJudgeInput[] =>
  [
    ...judges.map((judge) => ({
      role: benchRole(judge),
      nameAsPrinted: judge.name.trim(),
    })),
    ...dissentingOpinions.flatMap((opinion) =>
      opinion.authors.map((author) => ({
        role: DECISION_JUDGE_ROLE.DISSENTING,
        nameAsPrinted: author.trim(),
      })),
    ),
  ].filter(({ nameAsPrinted }) => nameAsPrinted.length > 0);

/** The decision form, whichever of the two shapes the payload states it in. */
const judgmentFormName = (
  form: SaosJudgmentForm | null | undefined,
): string | undefined =>
  toOptionalValue(typeof form === "string" ? form : form?.name);

const courtNameForItem = (item: SaosItem): string | undefined =>
  toOptionalValue(
    item.division?.court?.name ??
      (item.courtType
        ? (COURT_TYPE_MAP[item.courtType] ?? item.courtType)
        : undefined),
  );

/**
 * The per-judgment record's value for a field, or the listing row's.
 *
 * One helper for the whole build: the detail is the richer of the two and
 * the listing row is the only payload for a decision the detail endpoint
 * answered nothing for, so every field is read the same way round.
 */
const detailOrListing = <T>(
  fromDetail: T | null | undefined,
  fromListing: T | null | undefined,
): T | undefined => toOptionalValue(fromDetail ?? fromListing);

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
  | { type: "detail"; detail: SaosItem; payload: string }
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
  const fetched = await fetchDetail(id, signal);
  return fetched === null
    ? { type: "unavailable" }
    : { type: "detail", detail: fetched.item, payload: fetched.payload };
};

type BuildPlDecisionOptions = {
  /** The item exactly as the publisher listed it. */
  listingItem: SaosItem;
  /** The per-judgment record, where one was read. */
  detail: SaosItem | null;
  /**
   * Every response read for this decision, under its part name.
   *
   * Passed in rather than rebuilt from the records above: the row keeps what
   * the publisher served, and re-serializing this adapter's reading of it
   * would store the allowlist instead of the response.
   */
  rawParts: SourceRawParts;
};

/**
 * Build one decision from a listing item and whatever detail was read for it.
 *
 * Kept as one function so the crawl, the reconciliation walk and a replay of
 * a stored row cannot parse or enrich differently.
 */
export const buildPlDecision = ({
  listingItem,
  detail,
  rawParts,
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

  const saosId = detailOrListing(item.id, dumpItem.id);
  const content = item.textContent ?? dumpItem.textContent;
  const judgmentType = item.judgmentType ?? dumpItem.judgmentType;
  // What the document is, which is what its parser titles it by.
  const decisionType = normalizeDecisionType(judgmentType, content);
  // What a row holding this document alone is: a reasons document is one
  // only while no ruling holds it, and is typed as such.
  const storedDecisionType =
    judgmentType === SAOS_REASONS_JUDGMENT_TYPE
      ? PL_COURTS_STANDALONE_REASONS_DECISION_TYPE
      : decisionType;
  const upstreamId = detailOrListing(
    item.source?.judgmentId,
    dumpItem.source?.judgmentId,
  );
  const decisionDate = normalizeDecisionDate({
    stated: item.judgmentDate ?? dumpItem.judgmentDate,
    upstreamId,
    saosId,
  });
  const keywords = normalizeOptionalArray(item.keywords, dumpItem.keywords);
  const statutes = normalizeOptionalArray(item.legalBases, dumpItem.legalBases);
  const documentUrl = detailOrListing(
    item.source?.judgmentUrl,
    dumpItem.source?.judgmentUrl,
  );
  const effectiveCourtCases = item.courtCases ?? dumpItem.courtCases;
  const effectiveJudges = item.judges ?? dumpItem.judges;
  const effectiveDivision = item.division ?? dumpItem.division;
  const effectiveChambers = item.chambers ?? dumpItem.chambers;
  const effectiveSource = item.source ?? dumpItem.source;
  const dissentingOpinions = normalizeDissentingOpinions(
    normalizeOptionalArray(
      item.dissentingOpinions,
      dumpItem.dissentingOpinions,
    ),
  );
  const judges = decisionJudges({
    judges: normalizeOptionalArray(effectiveJudges),
    dissentingOpinions,
  });

  let documentAst: EmptyAst | IngestionResult["documentAst"] = EMPTY_AST;
  let fulltext = toOptionalValue(content ? stripHtml(content) : undefined);

  if (content) {
    try {
      const parserResult = parsePlDecisionContent({
        caseNumber,
        ecli: undefined,
        court: courtName,
        decisionDate,
        decisionType,
        sourceUrl: publicSourceUrl(saosId),
        documentUrl,
        content,
        keywords,
        statutes,
        documentId: upstreamId ?? String(saosId ?? caseNumber),
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
  const publisherIdentifiers: DecisionIdentifier[] = additionalCaseNumbers
    ? additionalCaseNumbers.map((value) => ({
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value,
      }))
    : [];
  const [firstPublisherIdentifier, ...otherPublisherIdentifiers] =
    publisherIdentifiers;

  const rawHash = hashContent(JSON.stringify(dumpItem));
  const detailHash =
    detail === null ? undefined : hashContent(JSON.stringify(detail));

  const publisherCitedCases = normalizeOptionalArray(
    item.referencedCourtCases,
    dumpItem.referencedCourtCases,
  )
    .map((referenced) => referenced.caseNumber?.trim() ?? "")
    .filter((caseNo) => caseNo.length > 0);

  return {
    caseNumber,
    ...(firstPublisherIdentifier === undefined
      ? {}
      : {
          identifiers: [firstPublisherIdentifier, ...otherPublisherIdentifiers],
        }),
    court: courtName,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_COURTS].country,
    language: "pl",
    decisionDate,
    decisionType: storedDecisionType,
    fulltext,
    sourceDocumentId: plCourtsSourceDocumentId(saosId),
    sourceUrl: publicSourceUrl(saosId),
    documentUrl,
    publisherCitedCases,
    judges,
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      summary: sourceTextField(
        ADAPTER_KEYS.PL_COURTS,
        detailOrListing(item.summary, dumpItem.summary),
      ),
    },
    metadata: checkedDecisionMetadata({
      caseNumber,
      court: courtName,
      decisionDate,
      decisionType: storedDecisionType,
      saosId,
      href: detailOrListing(item.href, dumpItem.href),
      courtType: detailOrListing(item.courtType, dumpItem.courtType),
      courtCases: effectiveCourtCases,
      judges: effectiveJudges?.map((judge) => ({
        name: judge.name,
        function: toOptionalValue(judge.function),
        specialRoles: normalizeOptionalArray(judge.specialRoles),
      })),
      keywords,
      division: effectiveDivision,
      chambers: effectiveChambers,
      personnelType: detailOrListing(
        item.personnelType,
        dumpItem.personnelType,
      ),
      judgmentForm: judgmentFormName(
        detailOrListing(item.judgmentForm, dumpItem.judgmentForm),
      ),
      source: effectiveSource,
      courtReporters,
      decision: detailOrListing(item.decision, dumpItem.decision),
      legalBases: statutes,
      referencedRegulations: normalizeOptionalArray(
        item.referencedRegulations,
        dumpItem.referencedRegulations,
      ),
      referencedCourtCases: normalizeOptionalArray(
        item.referencedCourtCases,
        dumpItem.referencedCourtCases,
      ),
      receiptDate: detailOrListing(item.receiptDate, dumpItem.receiptDate),
      meansOfAppeal: detailOrListing(
        item.meansOfAppeal,
        dumpItem.meansOfAppeal,
      ),
      judgmentResult: detailOrListing(
        item.judgmentResult,
        dumpItem.judgmentResult,
      ),
      lowerCourtJudgments: normalizeOptionalArray(
        item.lowerCourtJudgments,
        dumpItem.lowerCourtJudgments,
      ),
      dissentingOpinions,
      ingestion: {
        dumpHash: rawHash,
        sourceTier: detail ? "detail" : "dump",
        ...(detailHash === undefined ? {} : { detailHash }),
      },
      ...((additionalCaseNumbers?.length ?? 0) > 0 && {
        additionalCaseNumbers,
      }),
    }),
    rawHash,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_COURTS],
    documentAst,
    sourceRaw: encodeSourceRawEnvelope(rawParts),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

/**
 * Build what one listing item and its detail are: a decision, or the written
 * reasons of one.
 *
 * SAOS publishes the reasons of a ruling as a judgment of its own with
 * `judgmentType: REASONS`, under its own id and, where they were written
 * later, its own date. It states no link to the ruling: the two share the
 * court, the docket and, in the deciding court's own id, everything up to
 * the date (`…_IV_Ka_000095_2018_Uz_2018-03-22_001` is the ruling,
 * `…_002` its reasons). So the reasons are a supplement to the ruling under
 * their court and docket whose date is at or before theirs.
 *
 * An item with no SAOS id has no identity a supplement can be kept under,
 * and stays a decision.
 */
export const buildPlItem = (
  options: BuildPlDecisionOptions,
): IngestionItem | null => {
  const decision = buildPlDecision(options);
  if (decision === null) {
    return null;
  }
  const { sourceDocumentId } = decision;
  const judgmentType =
    options.detail?.judgmentType ?? options.listingItem.judgmentType;
  if (
    judgmentType !== SAOS_REASONS_JUDGMENT_TYPE ||
    sourceDocumentId === undefined
  ) {
    return { type: "decision", decision };
  }
  return {
    type: "supplement",
    supplement: {
      kind: DECISION_SUPPLEMENT_KIND.REASONS,
      target: {
        decisionTypes: PL_COURTS_RULING_DECISION_TYPES,
        latestDecisionDate: decision.decisionDate,
      },
      document: { ...decision, sourceDocumentId },
    },
  };
};

/**
 * The responses read for one decision, under the names the envelope gives
 * them: the listing row as the publisher served it, and the per-judgment
 * record where one came back.
 */
const rawPartsOf = (
  listingPart: (typeof RAW_PART)[keyof typeof RAW_PART],
  listingPayload: unknown,
  fetched: PlCourtsDetailFetch,
): SourceRawParts => ({
  [listingPart]: JSON.stringify(listingPayload),
  ...(fetched.type === "detail" ? { [RAW_PART.DETAIL]: fetched.payload } : {}),
});

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionItem | null> => {
  if (!isRecord(raw)) {
    return null;
  }

  const listingItem = normalizeSaosDumpItem(raw);
  const fetched = await fetchDetailForItem(listingItem, signal);
  return buildPlItem({
    listingItem,
    detail: fetched.type === "detail" ? fetched.detail : null,
    rawParts: rawPartsOf(RAW_PART.LISTING_DUMP, raw, fetched),
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
  /**
   * The publisher's own rows, verbatim.
   *
   * Not this adapter's reading of them: the row that named a decision is
   * kept as an envelope part, so what the walk carries has to be what the
   * search answered with.
   */
  records: Record<string, unknown>[];
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

  const response = await fetchPublisher(url, {
    adapterKey: ADAPTER_KEYS.PL_COURTS,
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

  const records = normalizeOptionalArray(json.items);
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
  if (records.length === 0 && page < totalPages) {
    throw new AdapterFetchError({
      message: `SAOS search API returned no judgments on page ${page} of ${totalPages} for the slice`,
      adapterKey: ADAPTER_KEYS.PL_COURTS,
      cursor: date,
    });
  }

  return { records, totalPages };
};

const listPlCourtsSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const { records, totalPages } = await listPlCourtsDayPage({
    date: slice,
    page,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    items: records.map((record) => ({
      identity: plCourtsListingIdentity(normalizeSaosDumpItem(record)),
      payload: record,
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
      const built = buildPlItem({
        listingItem,
        detail: fetched.type === "detail" ? fetched.detail : null,
        rawParts: rawPartsOf(RAW_PART.LISTING_SEARCH, payload, fetched),
      });
      if (built === null) {
        return { type: "unkeyable" };
      }
      switch (built.type) {
        case "decision":
          return { type: "built", decision: built.decision };
        case "supplement":
          return { type: "built-supplement", supplement: built.supplement };
        default: {
          built satisfies never;
          return panic(`Unhandled pl-courts item: ${JSON.stringify(built)}`);
        }
      }
    }
    default: {
      fetched satisfies never;
      return panic(
        `Unhandled pl-courts detail fetch: ${JSON.stringify(fetched)}`,
      );
    }
  }
};

// ── Replay ───────────────────────────────────────────────

const PL_COURTS_REPARSABLE_CONTENT_TYPES = new Set([
  "application/json",
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
]);

/**
 * Read both the current envelope and the wrapper stored before it.
 *
 * Rows written before the cutover carry `{ dumpItem, detail }` under
 * `application/json`, and every row this source has ever stored is one of
 * them, so the wrapper is a shape this reader accepts for good rather than
 * one it writes. The dump row it holds is the allowlisted reading of the
 * response rather than the response, which is why those rows state fewer
 * fields than the ones written since — and why the reading has to be usable
 * without them.
 */
const plCourtsStoredRawParts = (
  raw: string,
  contentType: string | null,
): SourceRawParts | null => {
  const envelope = decodeSourceRawEnvelope(raw);
  if (envelope !== null) {
    return envelope;
  }
  if (contentType !== null && contentType !== "application/json") {
    return null;
  }
  const parsed = Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
  if (!isRecord(parsed)) {
    return null;
  }
  const dumpItem = parsed["dumpItem"];
  const detail = parsed["detail"];
  if (!isRecord(dumpItem)) {
    return null;
  }
  return {
    [RAW_PART.LISTING_DUMP]: JSON.stringify(dumpItem),
    ...(isRecord(detail) ? { [RAW_PART.DETAIL]: JSON.stringify(detail) } : {}),
  };
};

/**
 * One stored part, back as the judgment record it holds.
 *
 * The per-judgment part is the publisher's whole answer, which wraps the
 * record in `data`; a listing part is the record itself. Both are unwrapped
 * here so no caller has to know which part it was handed.
 */
const readSaosRecord = (
  payload: string | undefined,
): Record<string, unknown> | null => {
  if (payload === undefined) {
    return null;
  }
  const parsed = Result.try((): unknown => JSON.parse(payload)).unwrapOr(null);
  if (!isRecord(parsed)) {
    return null;
  }
  const data = parsed["data"];
  return isRecord(data) ? data : parsed;
};

/** The listing row a stored envelope holds, from whichever listing named it. */
const storedListingPayload = (parts: SourceRawParts): string | undefined =>
  parts[RAW_PART.LISTING_DUMP] ?? parts[RAW_PART.LISTING_SEARCH];

/**
 * Rebuild a decision from the responses already stored for it.
 *
 * What this recovers is what the fields cost: the bench roles, the chamber,
 * the panel type and the decision form are all on responses the crawl
 * already paid for, so a row stored before this adapter read them is one
 * replay away from carrying them — and a row whose date was scanned out of
 * the prose is one replay away from losing that guess.
 */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !PL_COURTS_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }

  const parts = plCourtsStoredRawParts(
    new TextDecoder().decode(stored.raw),
    stored.contentType,
  );
  const listingRecord =
    parts === null ? null : readSaosRecord(storedListingPayload(parts));
  if (parts === null || listingRecord === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `no listing row in the stored payload for ${stored.caseNumber}`,
    };
  }

  const detailRecord = readSaosRecord(parts[RAW_PART.DETAIL]);
  const built = buildPlItem({
    listingItem: normalizeSaosDumpItem(listingRecord),
    detail: detailRecord === null ? null : normalizeSaosDumpItem(detailRecord),
    rawParts: parts,
  });
  if (built === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `the stored payload for ${stored.caseNumber} states no docket and court to key on`,
    };
  }
  const decision =
    built.type === "decision" ? built.decision : built.supplement.document;
  if (decision.caseNumber !== stored.caseNumber) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored payload states ${decision.caseNumber}`,
    };
  }
  switch (built.type) {
    case "decision":
      return { type: "parsed", result: built.decision };
    case "supplement":
      return { type: "supplement", supplement: built.supplement };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-courts item: ${JSON.stringify(built)}`);
    }
  }
};

// ── Source fields ──────────────────────────────────────

/**
 * Every field this source states for one decision, as a path into the record
 * it states them in.
 *
 * Paths rather than names because the record nests: `judges[].specialRoles`
 * and `dissentingOpinions[].authors` reach different places on the row than
 * the objects holding them, and a map keyed on `judges` alone could not say
 * so. The three per-decision payloads — the dump row, the search row and the
 * per-judgment record — answer with one shape and differ only in how much of
 * it they fill, so one list covers all three.
 */
const SOURCE_FIELDS = [
  "id",
  "href",
  "courtType",
  "courtCases",
  "courtCases[].caseNumber",
  "judgmentType",
  "judgmentDate",
  "judges",
  "judges[].name",
  "judges[].function",
  "judges[].specialRoles",
  "textContent",
  "keywords",
  "division",
  "division.id",
  "division.href",
  "division.name",
  "division.code",
  "division.type",
  "division.chamber",
  "division.chamber.id",
  "division.chamber.href",
  "division.chamber.name",
  "division.court",
  "division.court.id",
  "division.court.href",
  "division.court.name",
  "division.court.code",
  "division.court.type",
  "chambers",
  "chambers[].id",
  "chambers[].href",
  "chambers[].name",
  "personnelType",
  "judgmentForm",
  "judgmentForm.name",
  "source",
  "source.code",
  "source.judgmentUrl",
  "source.judgmentId",
  "source.publisher",
  "source.reviser",
  "source.publicationDate",
  "courtReporters",
  "decision",
  "summary",
  "legalBases",
  "referencedRegulations",
  "referencedRegulations[].journalTitle",
  "referencedRegulations[].journalYear",
  "referencedRegulations[].journalNo",
  "referencedRegulations[].journalEntry",
  "referencedRegulations[].text",
  "referencedCourtCases",
  "referencedCourtCases[].caseNumber",
  "referencedCourtCases[].judgmentIds",
  "referencedCourtCases[].generated",
  "receiptDate",
  "meansOfAppeal",
  "judgmentResult",
  "lowerCourtJudgments",
  "lowerCourtJudgments[].caseNumber",
  "dissentingOpinions",
  "dissentingOpinions[].textContent",
  "dissentingOpinions[].authors",
] as const;

/** The whole `division` object, which the row keeps under one metadata key. */
const DIVISION_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "division" },
} as const satisfies SourceFieldDisposition;

const CHAMBERS_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "chambers" },
} as const satisfies SourceFieldDisposition;

/** The provenance block, kept whole because its parts are read together. */
const SOURCE_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "source" },
} as const satisfies SourceFieldDisposition;

const REFERENCED_REGULATION_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "referencedRegulations" },
} as const satisfies SourceFieldDisposition;

const REFERENCED_COURT_CASE_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "referencedCourtCases" },
} as const satisfies SourceFieldDisposition;

/** Both roles of one list, which is why the result carries `judges`. */
const JUDGE_FIELD = {
  disposition: "stored",
  target: { type: "result", key: "judges" },
} as const satisfies SourceFieldDisposition;

const JUDGMENT_FORM_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "judgmentForm" },
} as const satisfies SourceFieldDisposition;

const LOWER_COURT_JUDGMENT_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "lowerCourtJudgments" },
} as const satisfies SourceFieldDisposition;

const DISSENTING_OPINION_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "dissentingOpinions" },
} as const satisfies SourceFieldDisposition;

const PL_COURTS_SOURCE_FIELDS = {
  id: { disposition: "stored", target: { type: "identity" } },
  href: { disposition: "stored", target: { type: "metadata", key: "href" } },
  courtType: {
    disposition: "stored",
    target: { type: "metadata", key: "courtType" },
  },
  courtCases: {
    disposition: "stored",
    target: { type: "metadata", key: "courtCases" },
  },
  "courtCases[].caseNumber": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  judgmentType: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  judgmentDate: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  judges: {
    disposition: "stored",
    target: { type: "metadata", key: "judges" },
  },
  "judges[].name": JUDGE_FIELD,
  "judges[].function": {
    disposition: "stored",
    target: { type: "metadata", key: "judges" },
  },
  "judges[].specialRoles": JUDGE_FIELD,
  textContent: { disposition: "stored", target: { type: "document" } },
  keywords: {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
  division: DIVISION_FIELD,
  "division.id": DIVISION_FIELD,
  "division.href": DIVISION_FIELD,
  "division.name": DIVISION_FIELD,
  "division.code": DIVISION_FIELD,
  "division.type": DIVISION_FIELD,
  "division.chamber": DIVISION_FIELD,
  "division.chamber.id": DIVISION_FIELD,
  "division.chamber.href": DIVISION_FIELD,
  "division.chamber.name": DIVISION_FIELD,
  "division.court": DIVISION_FIELD,
  "division.court.id": DIVISION_FIELD,
  "division.court.href": DIVISION_FIELD,
  "division.court.name": {
    disposition: "stored",
    target: { type: "result", key: "court" },
  },
  "division.court.code": DIVISION_FIELD,
  "division.court.type": DIVISION_FIELD,
  chambers: CHAMBERS_FIELD,
  "chambers[].id": CHAMBERS_FIELD,
  "chambers[].href": CHAMBERS_FIELD,
  "chambers[].name": CHAMBERS_FIELD,
  personnelType: {
    disposition: "stored",
    target: { type: "metadata", key: "personnelType" },
  },
  judgmentForm: JUDGMENT_FORM_FIELD,
  "judgmentForm.name": JUDGMENT_FORM_FIELD,
  source: SOURCE_FIELD,
  "source.code": SOURCE_FIELD,
  "source.judgmentUrl": {
    disposition: "stored",
    target: { type: "result", key: "documentUrl" },
  },
  "source.judgmentId": SOURCE_FIELD,
  "source.publisher": SOURCE_FIELD,
  "source.reviser": SOURCE_FIELD,
  "source.publicationDate": SOURCE_FIELD,
  courtReporters: {
    disposition: "stored",
    target: { type: "metadata", key: "courtReporters" },
  },
  decision: {
    disposition: "stored",
    target: { type: "metadata", key: "decision" },
  },
  summary: {
    disposition: "stored",
    target: { type: "textField", key: "summary" },
  },
  legalBases: {
    disposition: "stored",
    target: { type: "metadata", key: "legalBases" },
  },
  referencedRegulations: REFERENCED_REGULATION_FIELD,
  "referencedRegulations[].journalTitle": REFERENCED_REGULATION_FIELD,
  "referencedRegulations[].journalYear": REFERENCED_REGULATION_FIELD,
  "referencedRegulations[].journalNo": REFERENCED_REGULATION_FIELD,
  "referencedRegulations[].journalEntry": REFERENCED_REGULATION_FIELD,
  "referencedRegulations[].text": REFERENCED_REGULATION_FIELD,
  referencedCourtCases: REFERENCED_COURT_CASE_FIELD,
  "referencedCourtCases[].caseNumber": {
    disposition: "stored",
    target: { type: "result", key: "publisherCitedCases" },
  },
  "referencedCourtCases[].judgmentIds": REFERENCED_COURT_CASE_FIELD,
  "referencedCourtCases[].generated": REFERENCED_COURT_CASE_FIELD,
  receiptDate: {
    disposition: "stored",
    target: { type: "metadata", key: "receiptDate" },
  },
  meansOfAppeal: {
    disposition: "stored",
    target: { type: "metadata", key: "meansOfAppeal" },
  },
  judgmentResult: {
    disposition: "stored",
    target: { type: "metadata", key: "judgmentResult" },
  },
  lowerCourtJudgments: LOWER_COURT_JUDGMENT_FIELD,
  "lowerCourtJudgments[].caseNumber": LOWER_COURT_JUDGMENT_FIELD,
  dissentingOpinions: DISSENTING_OPINION_FIELD,
  "dissentingOpinions[].textContent": DISSENTING_OPINION_FIELD,
  "dissentingOpinions[].authors": JUDGE_FIELD,
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

/** Paths into one record, the object and array steps spelled as the map is. */
const collectFieldPaths = (
  record: Record<string, unknown>,
  prefix: string,
  into: Set<string>,
): void => {
  for (const [key, value] of Object.entries(record)) {
    const path = `${prefix}${key}`;
    into.add(path);
    if (isRecord(value)) {
      collectFieldPaths(value, `${path}.`, into);
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const element of value) {
      if (isRecord(element)) {
        collectFieldPaths(element, `${path}[].`, into);
      }
    }
  }
};

/**
 * What the stored responses state about this decision.
 *
 * Every part is read, not just the richest: the listing row is the only
 * payload for a decision whose detail fetch came back with nothing, and an
 * inventory blind to it would declare those records' fields out of scope by
 * accident.
 */
const listPlCourtsSourceFields = (parts: SourceRawParts): readonly string[] => {
  const paths = new Set<string>();
  for (const part of Object.values(RAW_PART)) {
    const record = readSaosRecord(parts[part]);
    if (record !== null) {
      collectFieldPaths(record, "", paths);
    }
  }
  return [...paths];
};

/**
 * Every payload the aggregator and the ministry's own service serve for one
 * decision, and whether the row keeps it.
 *
 * The three the crawl reads are the three it keeps, each as the publisher
 * served it: the dump row, the search row and the per-judgment record. What
 * is left out is the aggregator's own renderings of that record, two
 * corpus-wide endpoints, and the deciding court's service — which states
 * fields the aggregator does not, is a publisher of its own, and is read by
 * pl-ncourt.
 */
const SOURCE_SURFACES = [
  "listing-dump",
  "listing-search",
  "detail",
  "public-page",
  "html-download",
  "upstream-document",
  "citing-list",
  "enrichment",
  "court-dictionary",
  "upstream-detail",
  "upstream-listing",
  "portal-web-ui",
] as const;

const PL_COURTS_SOURCE_SURFACES = {
  surfaces: {
    "listing-dump": storedSourceSurface(RAW_PART.LISTING_DUMP),
    "listing-search": storedSourceSurface(RAW_PART.LISTING_SEARCH),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    "public-page": excludedSourceSurface(
      "the aggregator's own presentation of the detail record the row already stores",
    ),
    "html-download": excludedSourceSurface(
      "the same document text inside page chrome",
    ),
    "upstream-document": excludedSourceSurface(
      "the deciding court's own document, recorded by pl-ncourt under that publisher's own budget",
    ),
    "citing-list": excludedSourceSurface(
      "the inbound view of an edge the stored record already states outbound",
    ),
    enrichment: backlogSurface(
      ADAPTER_KEYS.PL_COURTS,
      "the endpoint is keyed by decision and offers no per-decision read, so reaching it means holding a corpus-wide dump",
    ),
    "court-dictionary": excludedSourceSurface(
      "reference data, not a payload about any one decision",
    ),
    "upstream-detail": excludedSourceSurface(
      "the deciding court's own record, recorded by pl-ncourt under that publisher's own budget",
    ),
    "upstream-listing": excludedSourceSurface(
      "a second listing of the same decisions: a coverage oracle rather than a field source",
    ),
    "portal-web-ui": excludedSourceSurface(
      "the deciding court's own record and document drawn for a browser, and answered to every other client as a scripted challenge carrying no field of any decision",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

export const plCourtsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_COURTS,
  sourceSurfaces: PL_COURTS_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: PL_COURTS_SOURCE_FIELDS,
    listSourceFields: listPlCourtsSourceFields,
  },
  language: "pl",
  minRequestIntervalMs: 200,
  pageTimeoutMs: 280_000,
  maxCycleMs: 30 * 60 * 1000,
  reparseStoredRaw,

  async getTotalCount(signal) {
    try {
      const response = await fetchPublisher(
        `${SEARCH_URL}?${new URLSearchParams({
          pageSize: "1",
          pageNumber: String(FIRST_PAGE),
          sortingField: "JUDGMENT_DATE",
          sortingDirection: "DESC",
        }).toString()}`,
        {
          adapterKey: ADAPTER_KEYS.PL_COURTS,
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

  fetchPage: createPagePaginatedFetch<SaosDumpPage>({
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    pageSize: PAGE_SIZE,
    legacyPageSize: LEGACY_PAGE_SIZE,
    firstPage: FIRST_PAGE,
    listTimeoutMs: 60_000,
    itemConcurrency: ITEM_CONCURRENCY,

    // The plain walk, for a source that configures none.
    buildRequest: (page) => dumpRequest(page, {}),
    walkKinds: PL_COURTS_WALK_KINDS,

    // Refused rather than read as an empty page: throwing here fails the
    // page, so the cursor holds and the shard is asked again next cycle
    // instead of being abandoned half-read.
    parseResponse: async (response) => {
      const json: unknown = await response.json();
      return isSaosDumpPage(json)
        ? Result.ok(json)
        : Result.err(
            new AdapterFetchError({
              message: "SAOS dump API returned a payload with no items array",
              adapterKey: ADAPTER_KEYS.PL_COURTS,
              // Reading a page is not told which cursor asked for it.
              cursor: null,
            }),
          );
    },

    extractItems: (data) => ({ items: data.items }),

    parseItem: parseItemWithDetail,
  }),
});
