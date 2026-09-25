/**
 * Polish competition and consumer protection authority (Prezes UOKiK) adapter.
 *
 * decyzje.uokik.gov.pl is a Lotus Domino database of the President's
 * decisions: competition (agreements, dominance, merger control), collective
 * consumer interests, unfair terms, product safety and conformity, fuel
 * quality, payment delays, contractual advantage and the rest. It is read
 * through three surfaces:
 *
 *   /bp/dec_prez.nsf/decyzje?ReadViewEntries&OutputFormat=JSON
 *       the flat view of every decision, sorted by decision date, newest
 *       first, the records stating no date ahead of all of them; each
 *       response states the view's total (`@toplevelentries`)
 *   /bp/dec_prez.nsf/1/{unid}?OpenDocument&act=Decyzja
 *       the decision's own page: a labelled table of its metadata and links to
 *       its files, the decision itself and the court rulings on its appeal
 *   /bp/dec_prez.nsf/0/{unid}/$FILE/{name}
 *       a file, nearly always a PDF with a text layer
 *
 * Identity is the Domino document UNID. The decision number is not unique:
 * the register reuses numbers across series, so it is the docket, never the
 * key.
 *
 * The court rulings a decision page attaches (the regional court's, the
 * appeal court's, the Supreme Court's) are rows of their own, keyed by the
 * decision's UNID and the file's name, filed under the court, docket, date and
 * kind their own header states, and keyed as the courts' own sources key the
 * same judgments. A ruling whose header states none of that readably (a scan,
 * most of the older ones) is kept unpublished, never filed under a guess.
 * Both the crawl and the year census read them with the decision's page, and
 * a decision whose page says its appeal is still before the courts is read
 * again each time the census walks its year, so a ruling attached later is
 * found there.
 *
 * The crawl walks the flat view oldest first (`NavigateReverse`), counting
 * positions from its oldest end, where a newly published decision never lands:
 * it carries a recent date, so it enters near the top. Every page re-reads the
 * rows before its anchor and resumes after the anchor's UNID, so a row
 * withdrawn or added below the anchor shifts nothing it reads. Once the walk
 * reaches the newest dated row it parks for the day, and a lap after that asks
 * one window past the anchor. A decision published late with an older date
 * lands below the anchor, where the crawl will not look again: the year census
 * below is what finds it.
 *
 * Reconciliation slices are decision years, plus `0000` for the records
 * stating no date. The view has no date filter, so a slice's rows are found by
 * bisecting the view on the date it is sorted by, and read with one row of
 * each neighbour, which has to lie outside the slice, or the slice is refused
 * rather than recorded short.
 *
 * Crawling policy: the database host serves no robots file, and the office's
 * own site allows every path this adapter reads to an agent it does not name.
 * The shared fetch identifies itself as Stella's ingestion agent, and the
 * publisher gate spaces requests two seconds apart.
 */

import { Result, panic } from "better-result";
import * as cheerio from "cheerio";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";
import { readCappedBytes } from "@stll/skills/streaming";
import { parsePlainDate, Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  STORED_RAW_REPARSE_REJECTION,
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
  SourceTotalCount,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { plCommonCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plSupremeCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-sn-ruling-keys";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  parsePlUokikDocument,
  plUokikDocumentLines,
  readPlUokikRulingHeader,
} from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import type {
  ParsePlUokikDocumentInput,
  ParsePlUokikDocumentOutput,
  PlUokikRulingHeader,
  PlUokikRulingUnread,
} from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const PL_UOKIK_ORIGIN = "https://decyzje.uokik.gov.pl";

/**
 * The only origin this adapter may reach. Every URL is built here from a UNID
 * or a file name checked against the register's format.
 */
const PL_UOKIK_HOST_POLICY = {
  type: "exact-origin",
  origins: [PL_UOKIK_ORIGIN],
} as const;

const DATABASE_PATH = "/bp/dec_prez.nsf";

/** The flat view of every decision, newest decision date first. */
const VIEW_NAME = "decyzje";

const ESCAPED_ORIGIN =
  "decyzje.uokik.gov.pl request escaped the publisher origin";

/** Shortest gap between two requests, from the policy map that enforces it. */
const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(
  ADAPTER_KEYS.PL_UOKIK,
);

/**
 * Decisions a crawl page collects. Each costs a detail request and a request
 * per decision file behind the two-second gate, so ten is under a minute.
 */
const CRAWL_PAGE_ROWS = 10;

/** Rows a crawl page re-reads before its anchor, to find it again. */
const CRAWL_OVERLAP_ROWS = 20;

/**
 * How far a crawl steps back when its anchor is gone from the window: past
 * any shift a withdrawal or late insertion below it could have caused, so the
 * step re-reads rows rather than skipping one.
 */
const LOST_ANCHOR_REWIND_ROWS = 200;

/** Rows one census read asks for; a decision year holds fewer. */
const SLICE_PAGE_ROWS = 2000;

/** Rows of the undated head one read asks for, and how many reads it may take. */
const UNDATED_HEAD_ROWS = 100;
const UNDATED_HEAD_MAX_READS = 10;

/**
 * Ceilings on one response. A view read of two thousand rows is about a
 * megabyte; a decision page about thirty kilobytes; the largest decision PDF
 * seen runs to a few megabytes. Each leaves an order of magnitude.
 */
const VIEW_MAX_BYTES = 32 * 1024 * 1024;
const DETAIL_MAX_BYTES = 4 * 1024 * 1024;
const FILE_MAX_BYTES = 64 * 1024 * 1024;

/** Timeout for one decision file, which may be several megabytes. */
const FILE_TIMEOUT_MS = 120_000;

const PL_UOKIK_LANGUAGE = "pl";

const PL_UOKIK_COUNTRY = ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_UOKIK].country;

/** Every record in this register is an administrative decision. */
const PL_UOKIK_DECISION_TYPE = "decyzja";

/** The oldest decision year the register holds. */
const PL_UOKIK_FIRST_YEAR = Number(
  ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_UOKIK].dateRange.fromInclusive.slice(0, 4),
);

/** A Domino document UNID, as the view states it. */
const UNID = /^[0-9A-F]{32}$/u;

const isUnid = (value: string | undefined): value is string =>
  value !== undefined &&
  UNID.test(value) &&
  isPersistableSourceDocumentId(value);

const viewUrl = (start: number, count: number, reverse: boolean): string =>
  `${PL_UOKIK_ORIGIN}${DATABASE_PATH}/${VIEW_NAME}?ReadViewEntries&OutputFormat=JSON&Start=${start}&Count=${count}${reverse ? "&NavigateReverse=1" : ""}`;

/** The decision's page, as the register's own search links it. */
export const plUokikDetailUrl = (unid: string): string =>
  `${PL_UOKIK_ORIGIN}${DATABASE_PATH}/1/${unid}?OpenDocument&act=Decyzja`;

/** A file segment the register names, checked before it becomes a path. */
const FILE_SEGMENT = /^[^/\\?#\p{Cc}]+$/u;

/**
 * A file's address, rebuilt from the decision's UNID and the file name its
 * page links, never from the link itself. Null for a name that is not one.
 */
export const plUokikFileUrl = (unid: string, name: string): string | null => {
  const segments = name.split("/");
  if (
    segments.some(
      (segment) =>
        !FILE_SEGMENT.test(segment) || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return `${PL_UOKIK_ORIGIN}${DATABASE_PATH}/0/${unid}/$FILE/${segments.map(encodeURIComponent).join("/")}`;
};

const publisherError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `decyzje.uokik.gov.pl: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_UOKIK,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

/** How the fetch layer reports a redirect it was told to refuse. */
const isRefusedRedirect = (error: unknown): boolean =>
  error instanceof TypeError &&
  "code" in error &&
  error.code === "UnexpectedRedirect";

type RequestOptions = {
  cursor: string;
  url: string;
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

/** One request, answered by its status and body, or refused at the boundary. */
type Answer =
  | { type: "body"; bytes: Uint8Array; url: string }
  | { type: "status"; status: number }
  | { type: "redirected" }
  | { type: "too-large" };

/**
 * One gated request to the register with its body read under a ceiling.
 * Redirects are refused; a dropped connection or an exhausted retry is an
 * error, which fails the page so it is asked again.
 */
const request = async ({
  accept,
  cursor,
  maxBytes,
  signal,
  timeoutMs,
  url,
}: RequestOptions): Promise<Result<Answer, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_UOKIK_HOST_POLICY,
    rawUrl: url,
  });
  if (target === null) {
    return panic(ESCAPED_ORIGIN);
  }
  const address = target.toString();
  const requested = await Result.tryPromise({
    try: async () =>
      await fetchWithRetry(
        address,
        { headers: { Accept: accept }, redirect: "error" },
        { adapterKey: ADAPTER_KEYS.PL_UOKIK, signal, timeoutMs },
      ),
    catch: (error: unknown) => error,
  });
  if (Result.isError(requested)) {
    return isRefusedRedirect(requested.error)
      ? Result.ok({ type: "redirected" })
      : Result.err(
          adapterCatch(ADAPTER_KEYS.PL_UOKIK, cursor)(requested.error),
        );
  }
  const response = requested.value;
  if (!response.ok) {
    await response.body?.cancel();
    return Result.ok({ type: "status", status: response.status });
  }
  const bytes =
    response.body === null
      ? new Uint8Array()
      : await readCappedBytes(response.body, maxBytes);
  return Result.ok(
    bytes === null
      ? { type: "too-large" }
      : { type: "body", bytes, url: address },
  );
};

// ── The flat view ────────────────────────────────────────

/** One view row, read leniently: what is read is checked, the rest kept. */
export type PlUokikViewRow = {
  /** The row's position in the view, counted from its newest end. */
  position: number | undefined;
  /** The row's UNID: the entry's own, or the one its detail link names. */
  unid: string | undefined;
  /** Where `unid` was read from, where it was not the entry's own field. */
  unidFrom: "link" | undefined;
  noteId: string | undefined;
  /** The one column the view states, as markup. */
  column: string | undefined;
  decisionNumber: string | undefined;
  /** As printed: `22.09.2026`. */
  datePrinted: string | undefined;
  decisionDate: string | undefined;
  parties: string | undefined;
  practices: string[];
  /** The UNID the row's link names. */
  linkedUnid: string | undefined;
};

const COLUMN_NUMBER = /Numer decyzji: <\/B>(?<number>[^<]*)<BR>/u;
const COLUMN_DATE = /Data decyzji:\s*\[<\/B>(?<date>[^<]*)<BR>\]/u;
const COLUMN_LINK =
  /<A HREF=\/bp\/dec_prez\.nsf\/0\/(?<unid>[0-9A-Fa-f]{32})\?OpenDocument[^>]*>(?<parties>[\s\S]*?)<\/A>\]/u;
const COLUMN_PRACTICE = /<\/A>\]\[<BR>\](?<practice>[\s\S]*?)\[<BR>\]$/u;
const PRINTED_DATE = /^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})$/u;

/** Markup text as a reader sees it: entities decoded, spacing collapsed. */
const textOf = (markup: string): string =>
  cheerio
    .load(`<body>${markup}</body>`)("body")
    .text()
    .replace(/\s+/gu, " ")
    .trim();

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** A day from the parts a pattern read, or undefined for one that is not a day. */
const dayOfGroups = (
  groups: Record<string, string | undefined> | undefined,
): string | undefined => {
  const year = groups?.["year"];
  const month = groups?.["month"];
  const date = groups?.["day"];
  if (year === undefined || month === undefined || date === undefined) {
    return undefined;
  }
  const day = `${year}-${month}-${date}`;
  return parsePlainDate(day) === null ? undefined : day;
};

/** `22.09.2026` as `2026-09-22`, or undefined for anything that is not a day. */
export const plUokikDayOfPrinted = (printed: string): string | undefined =>
  dayOfGroups(PRINTED_DATE.exec(printed.trim())?.groups);

const columnOf = (entry: Record<string, unknown>): string | undefined => {
  const data = entry["entrydata"];
  const listed: unknown[] = Array.isArray(data) ? data : [data];
  const first = listed.at(0);
  if (!isRecord(first)) {
    return undefined;
  }
  const text = first["text"];
  if (typeof text === "string") {
    return text;
  }
  if (isRecord(text) && typeof text["0"] === "string") {
    return text["0"];
  }
  return undefined;
};

/**
 * The row's exact publisher key: the entry's `@unid`, in any letter case, or
 * where the entry states none usable, the UNID its detail link addresses the
 * same document by.
 */
const unidOf = (
  stated: string | undefined,
  linked: string | undefined,
): Pick<PlUokikViewRow, "unid" | "unidFrom"> => {
  if (isUnid(stated)) {
    return { unid: stated, unidFrom: undefined };
  }
  return isUnid(linked)
    ? { unid: linked, unidFrom: "link" }
    : { unid: undefined, unidFrom: undefined };
};

export const normalizePlUokikRow = (
  entry: Record<string, unknown>,
): PlUokikViewRow => {
  const column = columnOf(entry);
  const position = Number(entry["@position"]);
  const unid =
    typeof entry["@unid"] === "string" ? entry["@unid"].trim() : undefined;
  const number = column === undefined ? undefined : COLUMN_NUMBER.exec(column);
  const date = column === undefined ? undefined : COLUMN_DATE.exec(column);
  const link = column === undefined ? undefined : COLUMN_LINK.exec(column);
  const practice =
    column === undefined ? undefined : COLUMN_PRACTICE.exec(column);
  const datePrinted = nonEmpty(date?.groups?.["date"]);
  return {
    position:
      Number.isSafeInteger(position) && position > 0 ? position : undefined,
    ...unidOf(unid?.toUpperCase(), link?.groups?.["unid"]?.toUpperCase()),
    noteId: typeof entry["@noteid"] === "string" ? entry["@noteid"] : undefined,
    column,
    decisionNumber: nonEmpty(textOf(number?.groups?.["number"] ?? "")),
    datePrinted,
    decisionDate:
      datePrinted === undefined ? undefined : plUokikDayOfPrinted(datePrinted),
    parties: nonEmpty(textOf(link?.groups?.["parties"] ?? "")),
    practices: (practice?.groups?.["practice"] ?? "")
      .split(/[\r\n]+/u)
      .map(textOf)
      .filter((item) => item.length > 0),
    linkedUnid: link?.groups?.["unid"]?.toUpperCase(),
  };
};

/**
 * What the view is sorted by, as a number: the decision year, or above every
 * year for a row stating none, which the view sorts ahead of all the others.
 */
const UNDATED_KEY = 10_000;

export const plUokikSortKey = (row: PlUokikViewRow): number =>
  row.decisionDate === undefined
    ? UNDATED_KEY
    : Number(row.decisionDate.slice(0, 4));

type ViewRead = {
  /** The view's size as this response states it. */
  total: number;
  /** Each row with the entry it was read from, verbatim. */
  rows: { entry: Record<string, unknown>; row: PlUokikViewRow }[];
  url: string;
};

/**
 * A view response, read strictly: an object stating its total, with a list of
 * entries or none at all, which is how Domino answers a range past its end.
 * Anything else is a failure, never an empty view.
 */
export const readPlUokikView = (
  value: unknown,
): Omit<ViewRead, "url"> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const total = Number(value["@toplevelentries"]);
  if (!Number.isSafeInteger(total) || total < 0) {
    return null;
  }
  const listed = value["viewentry"];
  if (listed !== undefined && !Array.isArray(listed) && !isRecord(listed)) {
    return null;
  }
  const many: unknown[] = Array.isArray(listed) ? listed : [];
  const entries: unknown[] =
    listed === undefined || Array.isArray(listed) ? many : [listed];
  if (!entries.every(isRecord)) {
    return null;
  }
  return {
    total,
    rows: entries.filter(isRecord).map((entry) => ({
      entry,
      row: normalizePlUokikRow(entry),
    })),
  };
};

/**
 * How many rows a read of `count` from `start` holds in a view of `total`:
 * none for a start outside it, otherwise every position up to its end. A
 * read answering fewer is a failure, never the view's end.
 */
const rowsInRange = (
  start: number,
  count: number,
  reverse: boolean,
  total: number,
): number => {
  if (start < 1 || start > total) {
    return 0;
  }
  return Math.min(count, reverse ? start : total - start + 1);
};

type ReadViewOptions = {
  cursor: string;
  start: number;
  count: number;
  reverse: boolean;
  signal?: AbortSignal | undefined;
};

/**
 * One read of the flat view. Every row it returns has to state the position
 * the request asked for next, in the direction asked: a response that skips or
 * repeats one is refused rather than read around.
 */
const readView = async ({
  count,
  cursor,
  reverse,
  signal,
  start,
}: ReadViewOptions): Promise<Result<ViewRead, AdapterFetchError>> => {
  const answered = await request({
    cursor,
    url: viewUrl(start, count, reverse),
    accept: "application/json",
    maxBytes: VIEW_MAX_BYTES,
    timeoutMs: ADAPTER_TIMEOUT.PAGE,
    signal,
  });
  if (Result.isError(answered)) {
    return answered;
  }
  const answer = answered.value;
  if (answer.type !== "body") {
    return Result.err(
      publisherError(
        cursor,
        `view answered ${answer.type === "status" ? answer.status : answer.type}`,
        answer.type === "status" ? answer.status : undefined,
      ),
    );
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(answer.bytes)),
    catch: () => null,
  }).unwrapOr(null);
  const view = readPlUokikView(parsed);
  if (view === null) {
    return Result.err(publisherError(cursor, "view answered no view entries"));
  }
  const step = reverse ? -1 : 1;
  const ordered = view.rows.every(
    ({ row }, index) => row.position === start + step * index,
  );
  if (
    !ordered ||
    view.rows.length !== rowsInRange(start, count, reverse, view.total)
  ) {
    return Result.err(
      publisherError(
        cursor,
        "view answered other rows than the positions asked hold",
      ),
    );
  }
  return Result.ok({ ...view, url: answer.url });
};

// ── Identity ─────────────────────────────────────────────

const QUARANTINE_PREFIX = "pl-uokik-quarantine:";

/** A link's target inside the view column, whatever it addresses. */
const LINK_TARGET = /HREF=[^\s>]*/gu;

/**
 * The audit identity of a row that states no usable UNID: a digest of its
 * column, which holds the decision number, date, parties and practice and
 * stays the same once the register states the UNID again. Undefined for a
 * row with no column either, which nothing could tell apart.
 */
export const plUokikQuarantineId = (row: PlUokikViewRow): string | undefined =>
  row.column === undefined
    ? undefined
    : `${QUARANTINE_PREFIX}${hashContent(
        // The link's target is the identity that went missing, so the digest
        // is taken without it and still names the row once it is back.
        row.column.replaceAll(LINK_TARGET, "HREF="),
      )}`;

const isQuarantineId = (sourceDocumentId: string): boolean =>
  sourceDocumentId.startsWith(QUARANTINE_PREFIX);

/** The identity a row is stored under, for the crawl and the census alike. */
export const plUokikListingIdentity = (
  row: PlUokikViewRow,
): ListingIdentity => {
  if (row.unid !== undefined) {
    return { type: "document", sourceDocumentId: row.unid };
  }
  const quarantineId = plUokikQuarantineId(row);
  return quarantineId === undefined
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId: quarantineId };
};

/** A quarantined row can hold nothing more until the register states its UNID. */
export const plUokikHeldWithoutDetail = (identity: ListingIdentity): boolean =>
  identity.type === "document" && isQuarantineId(identity.sourceDocumentId);

// ── The decision page ────────────────────────────────────

/** A file the decision page links, by the name the register gives it. */
export type PlUokikFile = { name: string; title: string | undefined };

/** One row of the decision page's table, as the page labels it. */
export type PlUokikDetailField = {
  /** The label without its colon; undefined where the row renders none. */
  label: string | undefined;
  text: string;
  files: PlUokikFile[];
};

export type PlUokikDetail = {
  /** The page's `<title>`, which names the register the page belongs to. */
  title: string | undefined;
  fields: PlUokikDetailField[];
};

/** The labels the decision page prints, and what each is. */
export const PL_UOKIK_LABEL = {
  NUMBER: "Numer decyzji",
  DATE: "Data wydania decyzji",
  FILE_REFERENCE: "Sygnatura akt",
  PARTIES: "Uczestnicy postępowania",
  PRACTICE: "Rodzaj praktyki",
  PENALTY: "Kara",
  INDUSTRY: "Branża",
  REGION: "Region",
  DECISION_FILES: "Decyzja",
  APPEALED: "Odwołanie do sądu",
  COURT_STATUS: "Status sprawy w sądzie",
  RULINGS: "Orzecznictwo",
} as const;

const KNOWN_LABELS: ReadonlySet<string> = new Set(
  Object.values(PL_UOKIK_LABEL),
);

const FILE_LINK = /\/\$FILE\/(?<name>.+)$/u;

const fileOf = (href: string): string | undefined => {
  const encoded = FILE_LINK.exec(href)?.groups?.["name"];
  if (encoded === undefined) {
    return undefined;
  }
  return Result.try({
    try: () => decodeURIComponent(encoded),
    catch: () => undefined,
  }).unwrapOr(undefined);
};

/**
 * The decision page's table, or null for a page that holds none: an answer
 * the register serves for a decision always states its number, so a page
 * without that row is markup this reader does not know, never an empty record.
 */
export const parsePlUokikDetail = (html: string): PlUokikDetail | null => {
  const $ = cheerio.load(html);
  const table = $("div.ck-content table").first();
  if (table.length === 0) {
    return null;
  }
  const fields: PlUokikDetailField[] = [];
  table
    .children("tbody")
    .children("tr")
    .add(table.children("tr"))
    .each((_, row) => {
      const cells = $(row).children("td");
      if (cells.length !== 2) {
        return;
      }
      const labelCell = cells.eq(0);
      // The table's last row is the page's own back link, not a field.
      if (labelCell.find("a").length > 0) {
        return;
      }
      const valueCell = cells.eq(1);
      const label = nonEmpty(
        labelCell.text().replace(/\s+/gu, " ").replace(/:\s*$/u, ""),
      );
      const files = valueCell
        .find("a[href]")
        .toArray()
        .flatMap((link) => {
          const name = fileOf($(link).attr("href") ?? "");
          return name === undefined
            ? []
            : [{ name, title: nonEmpty($(link).attr("title")) }];
        });
      fields.push({
        label,
        text: valueCell.text().replace(/\s+/gu, " ").trim(),
        files,
      });
    });
  if (!fields.some(({ label }) => label === PL_UOKIK_LABEL.NUMBER)) {
    return null;
  }
  return { title: nonEmpty($("title").first().text()), fields };
};

const fieldText = (
  detail: PlUokikDetail | undefined,
  label: string,
): string | undefined =>
  nonEmpty(detail?.fields.find((field) => field.label === label)?.text);

const fieldFiles = (
  detail: PlUokikDetail | undefined,
  label: string,
): PlUokikFile[] => {
  const field = detail?.fields.find((candidate) => candidate.label === label);
  return field === undefined ? [] : field.files;
};

/** `10/12/2009` (month first, as the page prints it) as `2009-10-12`. */
const US_DATE = /^(?<month>\d{2})\/(?<day>\d{2})\/(?<year>\d{4})$/u;

export const plUokikDayOfDetailDate = (
  printed: string | undefined,
): string | undefined =>
  dayOfGroups(US_DATE.exec(printed?.trim() ?? "")?.groups);

/** A list the page prints one item per line or separated by semicolons. */
const listOf = (text: string | undefined): string[] =>
  (text ?? "")
    .split(/;/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/**
 * The register a page names in its title, and the authority whose decisions
 * that register publishes. A page naming another is not filed under a guess.
 */
const AUTHORITY_OF_REGISTER: Readonly<Record<string, string>> = {
  "Decyzje Prezesa UOKiK": "Prezes Urzędu Ochrony Konkurencji i Konsumentów",
};

// ── Fetching a decision ──────────────────────────────────

/** Why a listed decision is stored on its view row alone. */
export const PL_UOKIK_DETAIL_STATUS = {
  NOT_FOUND: "detail-http-404",
  GONE: "detail-http-410",
  /** Requests here refuse redirects; which kind it was cannot be read. */
  REDIRECTED: "detail-redirected",
  TOO_LARGE: "detail-too-large",
  /** A page stating no decision table: markup this reader does not know. */
  UNRECOGNISED: "detail-unrecognised",
  /** The row states no UNID; see `plUokikQuarantineId`. */
  IDENTITY_UNAVAILABLE: "identity-unavailable",
} as const;

export type PlUokikDetailStatus =
  (typeof PL_UOKIK_DETAIL_STATUS)[keyof typeof PL_UOKIK_DETAIL_STATUS];

const DETAIL_STATUSES: ReadonlySet<string> = new Set(
  Object.values(PL_UOKIK_DETAIL_STATUS),
);

const isDetailStatus = (value: unknown): value is PlUokikDetailStatus =>
  typeof value === "string" && DETAIL_STATUSES.has(value);

/** What became of one decision file. */
export const PL_UOKIK_FILE_STATUS = {
  READ: "read",
  /** A scan served as an image file (TIFF, JPEG, PNG), which holds no text. */
  IMAGE: "image",
  NOT_PDF: "not-pdf",
  NOT_FOUND: "file-http-404",
  GONE: "file-http-410",
  REDIRECTED: "file-redirected",
  TOO_LARGE: "file-too-large",
  ADDRESS_UNUSABLE: "file-address-unusable",
} as const;

export type PlUokikFileStatus =
  (typeof PL_UOKIK_FILE_STATUS)[keyof typeof PL_UOKIK_FILE_STATUS];

/** One decision file as fetched: its bytes where it is a PDF. */
export type PlUokikFetchedFile = {
  name: string;
  status: PlUokikFileStatus;
  /** The bytes of a PDF or an image, kept beside the row. */
  bytes?: Uint8Array | undefined;
  /** An image's media type; a PDF's is implied by its status. */
  contentType?: string | undefined;
};

/** Answers that say a page or file is not there, as opposed to not now. */
const PERMANENT_ABSENCE: Readonly<Record<number, "404" | "410">> = {
  404: "404",
  410: "410",
};

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46];

const PDF_CONTENT_TYPE = "application/pdf";

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, index) => bytes[index] === byte);

const isPdf = (bytes: Uint8Array): boolean => startsWith(bytes, PDF_SIGNATURE);

/** TIFF in either byte order, JPEG and PNG: the forms a scan is filed in. */
const IMAGE_SIGNATURES = [
  { signature: [0x49, 0x49, 0x2a, 0x00], contentType: "image/tiff" },
  { signature: [0x4d, 0x4d, 0x00, 0x2a], contentType: "image/tiff" },
  { signature: [0xff, 0xd8, 0xff], contentType: "image/jpeg" },
  { signature: [0x89, 0x50, 0x4e, 0x47], contentType: "image/png" },
] as const;

/** The media type of an image a scan is filed as, or undefined for another file. */
const imageContentTypeOf = (bytes: Uint8Array): string | undefined =>
  IMAGE_SIGNATURES.find(({ signature }) => startsWith(bytes, signature))
    ?.contentType;

type FetchDetailOptions = {
  cursor: string;
  unid: string;
  signal?: AbortSignal | undefined;
};

type FetchedDetail =
  | { type: "served"; html: string }
  | { type: "absent"; status: PlUokikDetailStatus };

/**
 * The decision's page, or why it is absent for good (404, 410, a redirect,
 * past the ceiling); an error for anything that may clear (5xx, 429, any other
 * status, a dropped connection), so the page is asked again.
 */
const fetchDetail = async ({
  cursor,
  signal,
  unid,
}: FetchDetailOptions): Promise<Result<FetchedDetail, AdapterFetchError>> => {
  const answered = await request({
    cursor,
    url: plUokikDetailUrl(unid),
    accept: "text/html",
    maxBytes: DETAIL_MAX_BYTES,
    timeoutMs: ADAPTER_TIMEOUT.PAGE,
    signal,
  });
  if (Result.isError(answered)) {
    return answered;
  }
  const answer = answered.value;
  switch (answer.type) {
    case "body":
      return Result.ok({
        type: "served",
        html: new TextDecoder().decode(answer.bytes),
      });
    case "redirected":
      return Result.ok({
        type: "absent",
        status: PL_UOKIK_DETAIL_STATUS.REDIRECTED,
      });
    case "too-large":
      return Result.ok({
        type: "absent",
        status: PL_UOKIK_DETAIL_STATUS.TOO_LARGE,
      });
    case "status": {
      const permanent = PERMANENT_ABSENCE[answer.status];
      if (permanent === undefined) {
        return Result.err(
          publisherError(
            cursor,
            `decision page answered ${answer.status}`,
            answer.status,
          ),
        );
      }
      return Result.ok({
        type: "absent",
        status:
          permanent === "404"
            ? PL_UOKIK_DETAIL_STATUS.NOT_FOUND
            : PL_UOKIK_DETAIL_STATUS.GONE,
      });
    }
    default: {
      answer satisfies never;
      return panic(`Unhandled pl-uokik answer: ${JSON.stringify(answer)}`);
    }
  }
};

type FetchFileOptions = {
  cursor: string;
  unid: string;
  file: PlUokikFile;
  signal?: AbortSignal | undefined;
};

/**
 * One decision file: its bytes where it is a PDF, its status where it is gone
 * for good or is not one; an error for an answer that may clear.
 */
const fetchFile = async ({
  cursor,
  file,
  signal,
  unid,
}: FetchFileOptions): Promise<
  Result<PlUokikFetchedFile, AdapterFetchError>
> => {
  const url = plUokikFileUrl(unid, file.name);
  if (url === null) {
    return Result.ok({
      name: file.name,
      status: PL_UOKIK_FILE_STATUS.ADDRESS_UNUSABLE,
    });
  }
  const answered = await request({
    cursor,
    url,
    accept: "application/pdf",
    maxBytes: FILE_MAX_BYTES,
    timeoutMs: FILE_TIMEOUT_MS,
    signal,
  });
  if (Result.isError(answered)) {
    return answered;
  }
  const answer = answered.value;
  switch (answer.type) {
    case "body": {
      if (isPdf(answer.bytes)) {
        return Result.ok({
          name: file.name,
          status: PL_UOKIK_FILE_STATUS.READ,
          bytes: answer.bytes,
        });
      }
      // A scan is kept as served: it is the copy a later pass reads.
      const image = imageContentTypeOf(answer.bytes);
      return Result.ok(
        image === undefined
          ? { name: file.name, status: PL_UOKIK_FILE_STATUS.NOT_PDF }
          : {
              name: file.name,
              status: PL_UOKIK_FILE_STATUS.IMAGE,
              bytes: answer.bytes,
              contentType: image,
            },
      );
    }
    case "redirected":
      return Result.ok({
        name: file.name,
        status: PL_UOKIK_FILE_STATUS.REDIRECTED,
      });
    case "too-large":
      logger.warn("case_law.ingestion.document_too_large", {
        adapterKey: ADAPTER_KEYS.PL_UOKIK,
        sourceDocumentId: unid,
        maxBytes: FILE_MAX_BYTES,
      });
      return Result.ok({
        name: file.name,
        status: PL_UOKIK_FILE_STATUS.TOO_LARGE,
      });
    case "status": {
      const permanent = PERMANENT_ABSENCE[answer.status];
      if (permanent === undefined) {
        return Result.err(
          publisherError(
            cursor,
            `decision file answered ${answer.status}`,
            answer.status,
          ),
        );
      }
      return Result.ok({
        name: file.name,
        status:
          permanent === "404"
            ? PL_UOKIK_FILE_STATUS.NOT_FOUND
            : PL_UOKIK_FILE_STATUS.GONE,
      });
    }
    default: {
      answer satisfies never;
      return panic(`Unhandled pl-uokik answer: ${JSON.stringify(answer)}`);
    }
  }
};

// ── Building a decision ──────────────────────────────────

/**
 * The parts of the stored envelope, named by the response each holds, and the
 * objects the decision files are kept as beside it.
 */
const RAW_PART = {
  LISTING: "listing",
  DETAIL: "detail",
} as const;

const FILE_OBJECT = "decision-file";

/** `decision-file`, then `decision-file-2` and on for a decision of several. */
export const plUokikFileObjectName = (index: number): string =>
  index === 0 ? FILE_OBJECT : `${FILE_OBJECT}-${index + 1}`;

export const plUokikRawPartsOf = (
  entry: Record<string, unknown>,
  detailHtml: string | undefined,
): SourceRawParts => ({
  [RAW_PART.LISTING]: JSON.stringify(entry),
  ...(detailHtml === undefined ? {} : { [RAW_PART.DETAIL]: detailHtml }),
});

export type PlUokikBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No UNID and no column to fingerprint; nothing can store this row. */
  | { type: "unkeyable" }
  /** Listed, and stored on its view row alone. */
  | { type: "detail-unavailable"; decision: IngestionResult };

type MissingDetailOptions = {
  quarantined: boolean;
  detail: PlUokikDetail | undefined;
  detailStatus: PlUokikDetailStatus | undefined;
};

/** Why a row is stored without its page, or undefined where the page is read. */
const missingDetailOf = ({
  detail,
  detailStatus,
  quarantined,
}: MissingDetailOptions): PlUokikDetailStatus | undefined => {
  if (quarantined) {
    return PL_UOKIK_DETAIL_STATUS.IDENTITY_UNAVAILABLE;
  }
  if (detail !== undefined) {
    return undefined;
  }
  return detailStatus ?? PL_UOKIK_DETAIL_STATUS.UNRECOGNISED;
};

export type AssemblePlUokikDecisionOptions = {
  entry: Record<string, unknown>;
  rawParts: SourceRawParts;
  /** Why the page is absent, where the fetch said. */
  detailStatus?: PlUokikDetailStatus | undefined;
  /** The decision files in the order the page lists them. */
  files?: readonly PlUokikFetchedFile[] | undefined;
};

/**
 * The register's stand-in for a record with no number (`-/`, `-0/2024`):
 * no letters, so no issuing unit, and so no decision number.
 */
const isPlaceholderNumber = (number: string): boolean => !/\p{L}/u.test(number);

/** The ordinal and year after the register's last hyphen: `…-51/2006`. */
const ORDINAL_AFTER_HYPHEN = /^(?<unit>.+)-(?<ordinal>\d{1,4}\/\d{4})$/u;

/**
 * The decision number as the register prints it, and as the office's own
 * decisions and the courts reviewing them print it, with a space before the
 * ordinal ("DECYZJA nr RPZ 30/2005", "Nr RKR 51/2006"). Both spellings are
 * identifiers of the one decision, so a citation in either form meets it.
 */
export const plUokikDecisionIdentifiers = (
  caseNumber: string,
): DecisionIdentifiers => {
  const printed = {
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value: caseNumber,
  } as const;
  const groups = ORDINAL_AFTER_HYPHEN.exec(caseNumber)?.groups;
  const unit = groups?.["unit"];
  const ordinal = groups?.["ordinal"];
  return unit === undefined ||
    ordinal === undefined ||
    DECISION_DOCKET_GRAMMARS.POL.parse(caseNumber) === null
    ? [printed]
    : [
        printed,
        {
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value: `${unit} ${ordinal}`,
        },
      ];
};

type KeptFile = { bytes: Uint8Array; contentType: string };

/** The files whose bytes the row keeps: its PDFs and its scans. */
const keptFilesOf = (files: readonly PlUokikFetchedFile[]): KeptFile[] =>
  files.flatMap(({ bytes, contentType, status }) => {
    // A file read as a PDF is one by its signature.
    const type =
      status === PL_UOKIK_FILE_STATUS.READ ? PDF_CONTENT_TYPE : contentType;
    return bytes === undefined || type === undefined
      ? []
      : [{ bytes, contentType: type }];
  });

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

type DocumentRead =
  | { type: "read"; output: ParsePlUokikDocumentOutput }
  /** The files hold no text layer: a scan. */
  | { type: "no-text" }
  /** The reader failed on them. */
  | { type: "failed" };

/**
 * The document the files hold, or why there is none. A failure is not the
 * decision's: the files are kept beside the envelope, so their text is
 * recoverable by reading them again.
 */
const readDocument = async (
  input: ParsePlUokikDocumentInput,
): Promise<DocumentRead> => {
  if (input.pdfs.length === 0) {
    return { type: "no-text" };
  }
  const read = await Result.tryPromise({
    try: async () => await parsePlUokikDocument(input),
    catch: errorTag,
  });
  if (Result.isOk(read)) {
    return read.value === null
      ? { type: "no-text" }
      : { type: "read", output: read.value };
  }
  logger.warn("case_law.ingestion.document_parse_failed", {
    adapterKey: ADAPTER_KEYS.PL_UOKIK,
    caseNumber: input.caseNumber,
    "error.type": read.error,
  });
  return { type: "failed" };
};

/**
 * Why a decision whose page was read holds no text, where the reason is one
 * that holds for good: its files are scans, or it has none. A row stating one
 * of these is complete without a document, so the census stops asking for it;
 * a later pass that can read scans selects exactly these rows.
 */
export const PL_UOKIK_DOCUMENT_ABSENCE = {
  /** Every decision file is an image, or a PDF without a text layer. */
  SCANNED: "scanned",
  /** The page lists no decision file. */
  NO_ATTACHMENT: "no-attachment",
} as const;

export type PlUokikDocumentAbsence =
  (typeof PL_UOKIK_DOCUMENT_ABSENCE)[keyof typeof PL_UOKIK_DOCUMENT_ABSENCE];

/** The metadata key the reason is stored under. */
export const PL_UOKIK_DOCUMENT_ABSENCE_KEY = "documentAbsence";

/**
 * A decision whose page says it was appealed and that no court has ruled for
 * good: the register attaches the rulings to this page as they come, so the
 * census reads the page again each time it walks the decision's year.
 */
export const PL_UOKIK_APPEAL_WATCH = {
  AWAITING_RULING: "awaiting-ruling",
} as const;

/** The metadata key the watch is stored under. */
export const PL_UOKIK_APPEAL_WATCH_KEY = "appealWatch";

/** What the page prints for an appeal lodged, and for a case still before the court. */
const APPEALED = "Tak";
const CASE_PENDING = "Sprawa w toku";

/**
 * Whether the page states an appeal still waiting on a court: a case the page
 * says is pending, or, where it prints no status, an appeal with no ruling
 * attached yet.
 */
const appealWatchOf = (
  detail: PlUokikDetail | undefined,
): Record<string, unknown> => {
  if (fieldText(detail, PL_UOKIK_LABEL.APPEALED) !== APPEALED) {
    return {};
  }
  const status = fieldText(detail, PL_UOKIK_LABEL.COURT_STATUS);
  const waiting =
    status === undefined
      ? fieldFiles(detail, PL_UOKIK_LABEL.RULINGS).length === 0
      : status === CASE_PENDING;
  return waiting
    ? { [PL_UOKIK_APPEAL_WATCH_KEY]: PL_UOKIK_APPEAL_WATCH.AWAITING_RULING }
    : {};
};

const SCAN_FILE_STATUSES: ReadonlySet<PlUokikFileStatus> = new Set([
  PL_UOKIK_FILE_STATUS.READ,
  PL_UOKIK_FILE_STATUS.IMAGE,
]);

type DocumentAbsenceOptions = {
  listed: number;
  files: readonly PlUokikFetchedFile[];
  read: DocumentRead;
};

/**
 * The lasting reason a read page yields no text, or undefined where the
 * absence may still clear (a file gone, too large, unreadable, of another
 * format) and the census should keep asking.
 */
const documentAbsenceOf = ({
  files,
  listed,
  read,
}: DocumentAbsenceOptions): PlUokikDocumentAbsence | undefined => {
  if (listed === 0) {
    return PL_UOKIK_DOCUMENT_ABSENCE.NO_ATTACHMENT;
  }
  const allScans =
    files.length === listed &&
    files.every(({ status }) => SCAN_FILE_STATUSES.has(status));
  return read.type === "no-text" && allScans
    ? PL_UOKIK_DOCUMENT_ABSENCE.SCANNED
    : undefined;
};

type PageMetadataOptions = {
  detail: PlUokikDetail | undefined;
  row: PlUokikViewRow;
  /** The UNID file addresses are built under; undefined for a quarantined row. */
  id: string | undefined;
  files: readonly PlUokikFetchedFile[];
};

const addressOf = (id: string | undefined, file: PlUokikFile) =>
  id === undefined ? undefined : (plUokikFileUrl(id, file.name) ?? undefined);

/** What the decision page states, under the keys the inventory names. */
const pageMetadataOf = ({
  detail,
  files,
  id,
  row,
}: PageMetadataOptions): Record<string, unknown> => {
  const practices = listOf(
    fieldText(detail, PL_UOKIK_LABEL.PRACTICE)?.replaceAll("\n", ";"),
  );
  // A row stored without its page states no fields of it.
  const fields = detail === undefined ? [] : detail.fields;
  const otherFields = fields.flatMap((field) =>
    field.label !== undefined && !KNOWN_LABELS.has(field.label)
      ? [{ label: field.label, text: field.text, files: field.files }]
      : [],
  );
  if (otherFields.length > 0) {
    logger.warn("case_law.ingestion.source_field_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_UOKIK,
      fields: otherFields.map(({ label }) => label).join(", "),
    });
  }
  const unlabelled = fields.flatMap((field) =>
    field.label === undefined ? [{ text: field.text, files: field.files }] : [],
  );
  return {
    decisionDateAsPrinted: fieldText(detail, PL_UOKIK_LABEL.DATE),
    fileReference: fieldText(detail, PL_UOKIK_LABEL.FILE_REFERENCE),
    parties: fieldText(detail, PL_UOKIK_LABEL.PARTIES) ?? row.parties,
    practices: practices.length > 0 ? practices : row.practices,
    keywords: practices.length > 0 ? practices : row.practices,
    penalty: fieldText(detail, PL_UOKIK_LABEL.PENALTY),
    industries: (fieldText(detail, PL_UOKIK_LABEL.INDUSTRY) ?? "")
      .split(/\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    regions: listOf(fieldText(detail, PL_UOKIK_LABEL.REGION)),
    appealed: fieldText(detail, PL_UOKIK_LABEL.APPEALED),
    courtStatus: fieldText(detail, PL_UOKIK_LABEL.COURT_STATUS),
    decisionFiles: fieldFiles(detail, PL_UOKIK_LABEL.DECISION_FILES).map(
      (file, index) => {
        const fetched = files[index];
        return {
          name: file.name,
          title: file.title,
          documentUrl: addressOf(id, file),
          status: fetched?.status,
          sha256:
            fetched?.bytes === undefined ? undefined : sha256(fetched.bytes),
        };
      },
    ),
    // The courts publish their own rulings; the register's copies are linked
    // by name and address, and never fetched.
    // Each ruling is a row of its own, under the identity named here.
    appealRulings: fieldFiles(detail, PL_UOKIK_LABEL.RULINGS).map((file) => ({
      name: file.name,
      title: file.title,
      documentUrl: addressOf(id, file),
      sourceDocumentId:
        id === undefined ? undefined : plUokikRulingId(id, file.name),
    })),
    ...(otherFields.length === 0 ? {} : { otherFields }),
    ...(unlabelled.length === 0 ? {} : { unlabelledFields: unlabelled }),
  };
};

type DocumentStateOptions = DocumentAbsenceOptions & { listingOnly: boolean };

/**
 * What the row states about its missing text: a lasting reason under the key
 * the census reads, or that the files could not be read, which it keeps
 * asking about. Nothing for a row with text, or one stored without its page.
 */
const documentStateOf = ({
  listingOnly,
  ...options
}: DocumentStateOptions): Record<string, unknown> => {
  if (listingOnly || options.read.type === "read") {
    return {};
  }
  const absence = documentAbsenceOf(options);
  return absence === undefined
    ? { documentStatus: "unreadable" }
    : { [PL_UOKIK_DOCUMENT_ABSENCE_KEY]: absence };
};

/** The quarantine digest a keyed row would have had, for a later repair. */
const repairAliasesOf = (
  row: PlUokikViewRow,
): { sourceDocumentIdRepairAliases?: string[] } => {
  const quarantineId = plUokikQuarantineId(row);
  return quarantineId === undefined
    ? {}
    : { sourceDocumentIdRepairAliases: [quarantineId] };
};

/**
 * Build one decision from the responses already in hand. The crawl, the
 * census and a replay reach this with the same parts, so none of them can key
 * or read a record differently.
 */
export const assemblePlUokikDecision = async ({
  detailStatus,
  entry,
  files = [],
  rawParts,
}: AssemblePlUokikDecisionOptions): Promise<PlUokikBuildResult> => {
  const row = normalizePlUokikRow(entry);
  const identity = plUokikListingIdentity(row);
  if (identity.type !== "document") {
    return { type: "unkeyable" };
  }
  const id = identity.sourceDocumentId;
  const quarantined = isQuarantineId(id);
  const detailHtml = rawParts[RAW_PART.DETAIL];
  const detail =
    detailHtml === undefined
      ? undefined
      : (parsePlUokikDetail(detailHtml) ?? undefined);
  const missing = missingDetailOf({ quarantined, detail, detailStatus });
  if (quarantined) {
    logger.warn("case_law.ingestion.record_quarantined", {
      adapterKey: ADAPTER_KEYS.PL_UOKIK,
      sourceDocumentId: id,
    });
  }

  const number =
    fieldText(detail, PL_UOKIK_LABEL.NUMBER) ?? row.decisionNumber ?? "";
  const placeholder = isPlaceholderNumber(number);
  const caseNumber = placeholder ? id : number.replace(/\s+/gu, " ");
  const decisionDate =
    plUokikDayOfDetailDate(fieldText(detail, PL_UOKIK_LABEL.DATE)) ??
    row.decisionDate;
  const register = detail?.title;
  const court =
    register === undefined ? undefined : AUTHORITY_OF_REGISTER[register];
  // A row stored without its page names no register; its status says why.
  if (detail !== undefined && court === undefined) {
    logger.warn("case_law.ingestion.court_not_stated", {
      adapterKey: ADAPTER_KEYS.PL_UOKIK,
      sourceDocumentId: id,
      court: register ?? "",
    });
  }
  const authority = court ?? "";
  const sourceUrl = quarantined ? undefined : plUokikDetailUrl(id);
  const decisionFiles = fieldFiles(detail, PL_UOKIK_LABEL.DECISION_FILES);
  const firstFileUrl =
    quarantined || decisionFiles[0] === undefined
      ? undefined
      : (plUokikFileUrl(id, decisionFiles[0].name) ?? undefined);
  const practices = listOf(
    fieldText(detail, PL_UOKIK_LABEL.PRACTICE)?.replaceAll("\n", ";"),
  );

  const pdfs = files.flatMap(({ bytes, status }) =>
    bytes === undefined || status !== PL_UOKIK_FILE_STATUS.READ ? [] : [bytes],
  );
  const kept = keptFilesOf(files);
  const read = await readDocument({
    pdfs,
    caseNumber,
    court: authority,
    decisionDate,
    decisionType: PL_UOKIK_DECISION_TYPE,
    sourceUrl: sourceUrl ?? "",
    documentUrl: firstFileUrl,
    documentId: id,
    keywords: practices,
  });
  const document = read.type === "read" ? read.output : null;
  const documentAst: DocumentAst | EmptyAst =
    document?.documentAst ?? EMPTY_AST;

  const sourceRaw = encodeSourceRawEnvelope(rawParts);
  // A page naming another register is kept unpublished with the reason,
  // never published under no authority.
  const courtUnknown = detail !== undefined && court === undefined;
  const listingOnly = missing !== undefined || courtUnknown;
  const decision: IngestionResult = {
    caseNumber,
    ...(placeholder
      ? { caseNumberIsPlaceholder: true }
      : { identifiers: plUokikDecisionIdentifiers(caseNumber) }),
    sourceDocumentId: id,
    ...(quarantined ? {} : repairAliasesOf(row)),
    court: authority,
    country: PL_UOKIK_COUNTRY,
    language: PL_UOKIK_LANGUAGE,
    ...(decisionDate === undefined ? {} : { decisionDate }),
    decisionType: PL_UOKIK_DECISION_TYPE,
    ...(document === null ? {} : { fulltext: document.fulltext }),
    ...(listingOnly ? { isListingOnly: true } : {}),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(firstFileUrl === undefined ? {} : { documentUrl: firstFileUrl }),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court: authority,
      decisionDate,
      decisionType: PL_UOKIK_DECISION_TYPE,
      unid: row.unid,
      noteId: row.noteId,
      register,
      decisionNumber: number.length === 0 ? undefined : number,
      decisionNumberAsListed: row.decisionNumber,
      decisionDateAsListed: row.datePrinted,
      ...pageMetadataOf({
        detail,
        row,
        id: quarantined ? undefined : id,
        files,
      }),
      ...(missing === undefined ? {} : { detailStatus: missing }),
      ...(courtUnknown ? { quarantineReason: "court-not-stated" } : {}),
      ...appealWatchOf(detail),
      ...documentStateOf({
        listingOnly,
        read,
        files,
        listed: decisionFiles.length,
      }),
    }),
    // The files are stored beside the envelope rather than in it, so a
    // corrected file under an unchanged page has to change the hash too.
    rawHash: hashContent(
      [sourceRaw, ...kept.map(({ bytes }) => sha256(bytes))].join("\n"),
    ),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_UOKIK],
    documentAst,
    sourceRaw,
    ...(kept.length === 0
      ? {}
      : {
          sourceRawObjects: Object.fromEntries(
            kept.map((file, index) => [plUokikFileObjectName(index), file]),
          ),
        }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return listingOnly
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

// ── Court rulings on a decision's appeal ─────────────────

/**
 * The identity a ruling file is stored under: the decision's UNID and the
 * file's name, which is how the register addresses it. A name too long to
 * key on is keyed by its digest instead, never cut.
 */
export const plUokikRulingId = (unid: string, name: string): string => {
  const readable = `${unid}/${name}`;
  return isPersistableSourceDocumentId(readable)
    ? readable
    : `${unid}/sha256:${new Bun.CryptoHasher("sha256").update(name).digest("hex")}`;
};

/** The envelope part naming which of the decision page's files a row is. */
const RULING_NAME_PART = "ruling-file-name";

const RULING_OBJECT = "ruling-file";

/**
 * Why a ruling is kept without its text or its header: the file was not a
 * PDF with text, or its own header does not state what the row is keyed by.
 */
export type PlUokikRulingStatus =
  | PlUokikRulingUnread
  | Exclude<PlUokikFileStatus, typeof PL_UOKIK_FILE_STATUS.READ>;

/** The decision a ruling was filed under, as the ruling row links it. */
export type PlUokikDecisionLink = {
  sourceDocumentId: string;
  caseNumber: string;
  decisionDate: string | undefined;
};

export type AssemblePlUokikRulingOptions = {
  entry: Record<string, unknown>;
  detailHtml: string;
  unid: string;
  file: PlUokikFile;
  fetched: PlUokikFetchedFile;
  decision: PlUokikDecisionLink;
};

/**
 * The keys the same judgment is stored under by the sources that publish the
 * courts' own copies: the Supreme Court's and the common courts'.
 */
const rulingKeysOf = (header: PlUokikRulingHeader): string[] => {
  const keyed = {
    caseNumber: header.caseNumber,
    court: header.court,
    decisionDate: header.decisionDate,
    decisionType: header.decisionType,
  };
  const supreme = plSupremeCourtRulingKeys(keyed);
  return supreme.length > 0 ? supreme : plCommonCourtRulingKeys(keyed);
};

/**
 * One court ruling the register attaches to a decision, as a row of its own.
 * Its court, docket, date and kind are what its own header states; a ruling
 * whose header does not state them, or whose file holds no text, is kept on
 * what the register states about it and not published.
 */
export const assemblePlUokikRuling = async ({
  decision,
  detailHtml,
  entry,
  fetched,
  file,
  unid,
}: AssemblePlUokikRulingOptions): Promise<IngestionResult> => {
  const id = plUokikRulingId(unid, file.name);
  const documentUrl = plUokikFileUrl(unid, file.name) ?? undefined;
  const sourceUrl = plUokikDetailUrl(unid);
  const [kept] = keptFilesOf([fetched]);
  const bytes =
    fetched.status === PL_UOKIK_FILE_STATUS.READ ? fetched.bytes : undefined;
  const header =
    bytes === undefined
      ? undefined
      : readPlUokikRulingHeader(await plUokikDocumentLines([bytes]));
  const read = header?.type === "read" ? header.header : undefined;
  const unread = header?.type === "unread" ? header.reason : undefined;
  const status: PlUokikRulingStatus | undefined =
    fetched.status === PL_UOKIK_FILE_STATUS.READ ? unread : fetched.status;
  const document =
    read === undefined || bytes === undefined
      ? { type: "no-text" as const }
      : await readDocument({
          pdfs: [bytes],
          caseNumber: read.caseNumber,
          court: read.court,
          decisionDate: read.decisionDate,
          decisionType: read.decisionType,
          sourceUrl,
          documentUrl,
          documentId: id,
          keywords: [],
        });
  const parsed = document.type === "read" ? document.output : undefined;
  if (status !== undefined) {
    logger.warn("case_law.ingestion.record_quarantined", {
      adapterKey: ADAPTER_KEYS.PL_UOKIK,
      sourceDocumentId: id,
      reason: status,
    });
  }
  const sourceRaw = encodeSourceRawEnvelope({
    ...plUokikRawPartsOf(entry, detailHtml),
    [RULING_NAME_PART]: file.name,
  });
  const caseNumber = read?.caseNumber ?? id;
  return {
    caseNumber,
    ...(read === undefined ? { caseNumberIsPlaceholder: true } : {}),
    sourceDocumentId: id,
    court: read?.court ?? "",
    country: PL_UOKIK_COUNTRY,
    language: PL_UOKIK_LANGUAGE,
    ...(read === undefined
      ? {}
      : { decisionDate: read.decisionDate, decisionType: read.decisionType }),
    ...(parsed === undefined ? {} : { fulltext: parsed.fulltext }),
    // A ruling whose header could not be read is kept, not published: what
    // it is keyed and filed by would otherwise be a guess.
    ...(read === undefined ? { isListingOnly: true } : {}),
    sourceUrl,
    ...(documentUrl === undefined ? {} : { documentUrl }),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court: read?.court ?? "",
      decisionDate: read?.decisionDate,
      decisionType: read?.decisionType,
      recordClass: "court-ruling",
      uokikDecision: decision,
      attachmentName: file.name,
      attachmentTitle: file.title,
      attachmentStatus: fetched.status,
      attachmentSha256: kept === undefined ? undefined : sha256(kept.bytes),
      ...(read === undefined
        ? { rulingStatus: status }
        : {
            divisionAsPrinted: read.divisionAsPrinted,
            rulingKeys: rulingKeysOf(read),
          }),
    }),
    rawHash: hashContent(
      [sourceRaw, ...(kept === undefined ? [] : [sha256(kept.bytes)])].join(
        "\n",
      ),
    ),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_UOKIK],
    documentAst: parsed?.documentAst ?? EMPTY_AST,
    sourceRaw,
    ...(kept === undefined
      ? {}
      : {
          sourceRawObjects: {
            [RULING_OBJECT]: kept,
          },
        }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

type BuildOptions = {
  cursor: string;
  entry: Record<string, unknown>;
  signal?: AbortSignal | undefined;
};

/** One listed row as built: the decision, and the rulings filed under it. */
type PlUokikObservation = {
  built: PlUokikBuildResult;
  rulings: IngestionResult[];
};

/**
 * Fetch what a listed row still needs, the page and its decision files, and
 * assemble it. A refusal that may clear is the page's failure, so the caller
 * holds its cursor and asks again.
 */
const buildPlUokikDecision = async ({
  cursor,
  entry,
  signal,
}: BuildOptions): Promise<Result<PlUokikObservation, AdapterFetchError>> => {
  const row = normalizePlUokikRow(entry);
  if (row.unid === undefined) {
    return Result.ok({
      built: await assemblePlUokikDecision({
        entry,
        rawParts: plUokikRawPartsOf(entry, undefined),
      }),
      rulings: [],
    });
  }
  const fetched = await fetchDetail({ cursor, unid: row.unid, signal });
  if (Result.isError(fetched)) {
    return fetched;
  }
  if (fetched.value.type === "absent") {
    return Result.ok({
      built: await assemblePlUokikDecision({
        entry,
        rawParts: plUokikRawPartsOf(entry, undefined),
        detailStatus: fetched.value.status,
      }),
      rulings: [],
    });
  }
  const { html } = fetched.value;
  const detail = parsePlUokikDetail(html);
  const files: PlUokikFetchedFile[] = [];
  for (const file of fieldFiles(
    detail ?? undefined,
    PL_UOKIK_LABEL.DECISION_FILES,
  )) {
    // One file at a time, behind the publisher's gate.
    const got = await fetchFile({ cursor, unid: row.unid, file, signal });
    if (Result.isError(got)) {
      return got;
    }
    files.push(got.value);
  }
  const built = await assemblePlUokikDecision({
    entry,
    rawParts: plUokikRawPartsOf(entry, html),
    files,
  });
  if (built.type !== "built") {
    return Result.ok({ built, rulings: [] });
  }
  const decision: PlUokikDecisionLink = {
    sourceDocumentId: row.unid,
    caseNumber: built.decision.caseNumber,
    decisionDate: built.decision.decisionDate,
  };
  const rulings: IngestionResult[] = [];
  for (const file of fieldFiles(detail ?? undefined, PL_UOKIK_LABEL.RULINGS)) {
    // One file at a time, behind the publisher's gate.
    const got = await fetchFile({ cursor, unid: row.unid, file, signal });
    if (Result.isError(got)) {
      return got;
    }
    rulings.push(
      await assemblePlUokikRuling({
        entry,
        detailHtml: html,
        unid: row.unid,
        file,
        fetched: got.value,
        decision,
      }),
    );
  }
  return Result.ok({ built, rulings });
};

/**
 * Re-parse a stored envelope without contacting the register. A decision whose
 * document is a stored PDF is refused: a replay reads the envelope, and the
 * files are objects beside it.
 */
const reparsePlUokikStoredRaw = async (
  stored: StoredRawReparseInput,
): Promise<StoredRawReparseOutcome> => {
  const parts = decodeSourceRawEnvelope(new TextDecoder().decode(stored.raw));
  if (parts?.[RULING_NAME_PART] !== undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail:
        "a court ruling is read from its stored PDF, which a replay does not read",
    };
  }
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: (listing) => {
      const identity = plUokikListingIdentity(normalizePlUokikRow(listing));
      return identity.type === "document"
        ? identity.sourceDocumentId
        : undefined;
    },
  });
  if (read.type === "rejected") {
    return read;
  }
  const objects = decodeSourceRawEnvelopeObjects(
    new TextDecoder().decode(stored.raw),
  );
  if (objects[FILE_OBJECT] !== undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: "the document is the stored PDF, which a replay does not read",
    };
  }
  const storedStatus = stored.metadata["detailStatus"];
  const built = await assemblePlUokikDecision({
    entry: read.listing,
    rawParts: read.parts,
    ...(isDetailStatus(storedStatus) ? { detailStatus: storedStatus } : {}),
  });
  switch (built.type) {
    case "built":
    case "detail-unavailable":
      return { type: "parsed", result: built.decision };
    case "unkeyable":
      return {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: "the stored row states no UNID and no column",
      };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-uokik build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every field the envelope states: the view entry's own keys, what its one
 * column labels, the decision page's labels, and the files.
 */
const SOURCE_FIELDS = [
  "listing.@position",
  "listing.@unid",
  "listing.@noteid",
  "listing.@siblings",
  "listing.entrydata",
  "listing.column.Numer decyzji",
  "listing.column.Data decyzji",
  "listing.column.link",
  "listing.column.practice",
  "detail.title",
  "detail.Numer decyzji",
  "detail.Data wydania decyzji",
  "detail.Sygnatura akt",
  "detail.Uczestnicy postępowania",
  "detail.Rodzaj praktyki",
  "detail.Kara",
  "detail.Branża",
  "detail.Region",
  "detail.Decyzja",
  "detail.Odwołanie do sądu",
  "detail.Status sprawy w sądzie",
  "detail.Orzecznictwo",
  "detail.(unlabelled)",
] as const;

type PlUokikSourceField = (typeof SOURCE_FIELDS)[number];

const metadataField = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});

const PL_UOKIK_SOURCE_FIELDS = {
  "listing.@position": excludedSourceField(
    "the row's place in a view that shifts with every decision published; the crawl reads it, the row does not keep it",
  ),
  "listing.@unid": { disposition: "stored", target: { type: "identity" } },
  "listing.@noteid": metadataField("noteId"),
  "listing.@siblings": excludedSourceField(
    "the view's size, the same on every row; the total probe reads it",
  ),
  "listing.entrydata": excludedSourceField(
    "the column container; each value in it is declared below",
  ),
  "listing.column.Numer decyzji": metadataField("decisionNumberAsListed"),
  "listing.column.Data decyzji": metadataField("decisionDateAsListed"),
  "listing.column.link": metadataField("parties"),
  "listing.column.practice": metadataField("practices"),
  "detail.title": metadataField("register"),
  "detail.Numer decyzji": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "detail.Data wydania decyzji": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  "detail.Sygnatura akt": metadataField("fileReference"),
  "detail.Uczestnicy postępowania": metadataField("parties"),
  "detail.Rodzaj praktyki": metadataField("practices"),
  "detail.Kara": metadataField("penalty"),
  "detail.Branża": metadataField("industries"),
  "detail.Region": metadataField("regions"),
  "detail.Decyzja": metadataField("decisionFiles"),
  "detail.Odwołanie do sądu": metadataField("appealed"),
  "detail.Status sprawy w sądzie": metadataField("courtStatus"),
  "detail.Orzecznictwo": metadataField("appealRulings"),
  "detail.(unlabelled)": metadataField("unlabelledFields"),
} as const satisfies Record<PlUokikSourceField, SourceFieldDisposition>;

/**
 * What the stored envelope states, by name. A label the page starts printing
 * arrives here as a name the map has not decided.
 */
export const listPlUokikSourceFields = (
  parts: SourceRawParts,
): readonly string[] => {
  const fields = new Set<string>();
  const listing = Result.try({
    try: (): unknown => JSON.parse(parts[RAW_PART.LISTING] ?? ""),
    catch: () => null,
  }).unwrapOr(null);
  if (isRecord(listing)) {
    for (const key of Object.keys(listing)) {
      fields.add(`listing.${key}`);
    }
    const row = normalizePlUokikRow(listing);
    const column = row.column ?? "";
    if (COLUMN_NUMBER.test(column)) {
      fields.add("listing.column.Numer decyzji");
    }
    if (COLUMN_DATE.test(column)) {
      fields.add("listing.column.Data decyzji");
    }
    if (COLUMN_LINK.test(column)) {
      fields.add("listing.column.link");
    }
    if (COLUMN_PRACTICE.test(column)) {
      fields.add("listing.column.practice");
    }
  }
  const html = parts[RAW_PART.DETAIL];
  const detail = html === undefined ? null : parsePlUokikDetail(html);
  if (detail !== null) {
    if (detail.title !== undefined) {
      fields.add("detail.title");
    }
    for (const field of detail.fields) {
      fields.add(`detail.${field.label ?? "(unlabelled)"}`);
    }
  }
  return [...fields];
};

// ── Source surfaces ──────────────────────────────────────

const SOURCE_SURFACES = [
  "listing",
  "detail",
  "decision-file",
  "ruling-file",
  "open-document-page",
  "categorised-views",
  "search",
] as const;

const PL_UOKIK_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    "decision-file": storedSourceSurface(FILE_OBJECT),
    "ruling-file": storedSourceSurface(RULING_OBJECT),
    "open-document-page": excludedSourceSurface(
      "the same decision's plain page, which states its files and none of the table the kept page does",
    ),
    "categorised-views": excludedSourceSurface(
      "the same rows grouped by practice, year and industry, a rendering of the flat view kept above",
    ),
    search: excludedSourceSurface(
      "a query-scoped full-text search over the same records",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Crawl cursor ─────────────────────────────────────────

/**
 * Where the crawl stands on the view counted from its oldest end: every row
 * up to reverse position `read`, the row with UNID `anchor`, has been read.
 * `total` is the view's size when it was, which places `read` in the next
 * request. `walk` is the first pass; `tip` laps once per closed day.
 */
export type PlUokikCursor = {
  phase: "walk" | "tip";
  read: number;
  total: number;
  anchor: string | undefined;
  parkedOn?: string | undefined;
};

const CURSOR_PATTERN =
  /^(?<phase>walk|tip):(?<read>\d{1,9}):(?<total>\d{1,9}):(?<anchor>[0-9A-F]{32})?(?::(?<parked>\d{4}-\d{2}-\d{2}))?$/u;

const FRESH_CURSOR: PlUokikCursor = {
  phase: "walk",
  read: 0,
  total: 0,
  anchor: undefined,
};

/** A cursor this adapter did not write starts the walk from the oldest row. */
export const parsePlUokikCursor = (cursor: string | null): PlUokikCursor => {
  const groups =
    cursor === null ? undefined : CURSOR_PATTERN.exec(cursor)?.groups;
  if (groups === undefined) {
    return FRESH_CURSOR;
  }
  const parked = groups["parked"];
  return {
    phase: groups["phase"] === "tip" ? "tip" : "walk",
    read: Number(groups["read"]),
    total: Number(groups["total"]),
    anchor: groups["anchor"],
    ...(parked !== undefined && parsePlainDate(parked) !== null
      ? { parkedOn: parked }
      : {}),
  };
};

export const encodePlUokikCursor = ({
  anchor,
  parkedOn,
  phase,
  read,
  total,
}: PlUokikCursor): string =>
  `${phase}:${read}:${total}:${anchor ?? ""}${parkedOn === undefined ? "" : `:${parkedOn}`}`;

const todayUtc = (): string => Temporal.Now.plainDateISO("UTC").toString();

type Located = {
  rows: ViewRead["rows"];
  total: number;
  url: string;
};

/**
 * The rows past the anchor, read in a window that starts `CRAWL_OVERLAP_ROWS`
 * before it. Null where the anchor is not in the window even at the view's
 * current size: a row below it was withdrawn or added past what the overlap
 * absorbs, or the anchor itself was withdrawn.
 */
const readPastAnchor = async (
  position: PlUokikCursor,
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<Located | null, AdapterFetchError>> => {
  let total = position.total;
  if (total === 0) {
    const probe = await readView({
      cursor,
      start: 1,
      count: 1,
      reverse: false,
      signal,
    });
    if (Result.isError(probe)) {
      return probe;
    }
    total = probe.value.total;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const low = Math.max(1, position.read - CRAWL_OVERLAP_ROWS + 1);
    const start = total - low + 1;
    if (start < 1) {
      return Result.ok(null);
    }
    const overlap = position.read >= low ? position.read - low + 1 : 0;
    // Sequential by design: the second read exists only if the first read
    // saw the view at another size.
    const read = await readView({
      cursor,
      start,
      count: overlap + CRAWL_PAGE_ROWS,
      reverse: true,
      signal,
    });
    if (Result.isError(read)) {
      return read;
    }
    const view = read.value;
    if (view.total !== total && attempt === 0) {
      // The view changed size since the cursor was written, so the window was
      // placed against the wrong end; place it again against this size.
      total = view.total;
      continue;
    }
    const reversePosition = (row: PlUokikViewRow): number =>
      view.total - (row.position ?? 0) + 1;
    if (position.anchor === undefined) {
      return Result.ok({
        rows: view.rows.filter(
          ({ row }) => reversePosition(row) > position.read,
        ),
        total: view.total,
        url: view.url,
      });
    }
    const at = view.rows.findIndex(({ row }) => row.unid === position.anchor);
    if (at !== -1) {
      return Result.ok({
        rows: view.rows.slice(at + 1),
        total: view.total,
        url: view.url,
      });
    }
    return Result.ok(null);
  }
  return Result.ok(null);
};

type Collected = { decisions: IngestionResult[]; aborted: boolean };

const collectDecisions = async (
  entries: readonly Record<string, unknown>[],
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<Collected, AdapterFetchError>> => {
  const decisions: IngestionResult[] = [];
  for (const entry of entries) {
    if (signal?.aborted) {
      return Result.ok({ decisions, aborted: true });
    }
    // One decision at a time, behind the publisher's gate.
    const attempted = await buildPlUokikDecision({
      cursor,
      entry,
      signal,
    });
    if (Result.isError(attempted)) {
      return attempted;
    }
    const { built, rulings } = attempted.value;
    switch (built.type) {
      case "built":
      case "detail-unavailable":
        // The crawl keeps a row stored on its view row; only the census
        // refuses it, so the page is asked for again there.
        decisions.push(built.decision, ...rulings);
        break;
      case "unkeyable":
        logger.warn("case_law.ingestion.record_unidentifiable", {
          adapterKey: ADAPTER_KEYS.PL_UOKIK,
          cursor,
        });
        break;
      default: {
        built satisfies never;
        return panic(
          `Unhandled pl-uokik build result: ${JSON.stringify(built)}`,
        );
      }
    }
  }
  return Result.ok({ decisions, aborted: false });
};

/**
 * The rows stating no decision date, which the view sorts ahead of every
 * dated one: read from the view's newest end until the first dated row.
 */
const readUndatedHead = async (
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<Record<string, unknown>[], AdapterFetchError>> => {
  const entries: Record<string, unknown>[] = [];
  for (let read = 0; read < UNDATED_HEAD_MAX_READS; read += 1) {
    // Sequential by design: the next read starts where this one ended.
    const view = await readView({
      cursor,
      start: read * UNDATED_HEAD_ROWS + 1,
      count: UNDATED_HEAD_ROWS,
      reverse: false,
      signal,
    });
    if (Result.isError(view)) {
      return view;
    }
    for (const { entry, row } of view.value.rows) {
      if (plUokikSortKey(row) !== UNDATED_KEY) {
        return Result.ok(entries);
      }
      entries.push(entry);
    }
    if (view.value.rows.length < UNDATED_HEAD_ROWS) {
      return Result.ok(entries);
    }
  }
  return Result.err(
    publisherError(
      cursor,
      `more than ${UNDATED_HEAD_ROWS * UNDATED_HEAD_MAX_READS} rows state no decision date`,
    ),
  );
};

const plUokikFetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const position = parsePlUokikCursor(cursor);
  const encoded = encodePlUokikCursor(position);
  // Parked on a day that has not closed: this cycle has nothing to ask.
  if (
    position.phase === "tip" &&
    position.parkedOn !== undefined &&
    position.parkedOn >= todayUtc()
  ) {
    return Result.ok({ decisions: [], nextCursor: encoded });
  }
  const located = await readPastAnchor(position, encoded, signal);
  if (Result.isError(located)) {
    return located;
  }
  if (located.value === null) {
    logger.warn("case_law.ingestion.crawl_anchor_lost", {
      adapterKey: ADAPTER_KEYS.PL_UOKIK,
      cursor: encoded,
    });
    return Result.ok({
      decisions: [],
      nextCursor: encodePlUokikCursor({
        phase: position.phase,
        read: Math.max(0, position.read - LOST_ANCHOR_REWIND_ROWS),
        total: position.total,
        anchor: undefined,
      }),
    });
  }
  const { rows, total, url } = located.value;
  const dated: ViewRead["rows"] = [];
  for (const item of rows) {
    if (plUokikSortKey(item.row) === UNDATED_KEY) {
      break;
    }
    dated.push(item);
  }
  const taken = dated.slice(0, CRAWL_PAGE_ROWS);
  const reachedTop = taken.length < CRAWL_PAGE_ROWS;

  // The first walk to reach the top also reads the rows stating no date; a
  // later one leaves them to the census, which lists them as a slice.
  let undated: Record<string, unknown>[] = [];
  if (reachedTop && position.phase === "walk") {
    const head = await readUndatedHead(encoded, signal);
    if (Result.isError(head)) {
      return head;
    }
    undated = head.value;
  }
  const collected = await collectDecisions(
    [...taken.map(({ entry }) => entry), ...undated],
    encoded,
    signal,
  );
  if (Result.isError(collected)) {
    return collected;
  }
  const { aborted, decisions } = collected.value;
  if (aborted) {
    // The cycle stopped partway through, so it says nothing about the rows
    // it never reached; the page is read again next cycle.
    return Result.ok({ decisions, sourceUrl: url, nextCursor: encoded });
  }
  // A page of rows stating no UNID has nothing to anchor on; the cursor
  // still moves past them by position, or the walk would read them forever.
  const resumed =
    taken.findLast(({ row }) => row.unid !== undefined) ??
    taken.findLast(({ row }) => row.position !== undefined);
  const next: PlUokikCursor =
    resumed === undefined
      ? { ...position, total }
      : {
          phase: position.phase,
          read: total - (resumed.row.position ?? 0) + 1,
          total,
          anchor: resumed.row.unid,
        };
  return Result.ok({
    decisions,
    sourceUrl: url,
    nextCursor: encodePlUokikCursor(
      reachedTop
        ? {
            phase: "tip",
            read: next.read,
            total: next.total,
            anchor: next.anchor,
            parkedOn: todayUtc(),
          }
        : {
            phase: next.phase,
            read: next.read,
            total: next.total,
            anchor: next.anchor,
          },
    ),
  });
};

// ── Reconciliation ───────────────────────────────────────

/** The slice of the rows stating no date; it sorts ahead of every year. */
export const PL_UOKIK_UNDATED_SLICE = "0000";

const SLICE_YEAR = /^\d{4}$/u;

const sliceKeyOf = (slice: string): number => {
  if (slice === PL_UOKIK_UNDATED_SLICE) {
    return UNDATED_KEY;
  }
  return SLICE_YEAR.test(slice)
    ? Number(slice)
    : panic(`pl-uokik slice is not a year: ${slice}`);
};

const currentYear = (): number => Temporal.Now.plainDateISO("UTC").year;

const yearOf = (now: Date): string =>
  String(
    Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
      "UTC",
    ).year,
  );

export const plUokikNextSlice = (slice: string): string | null => {
  if (slice === PL_UOKIK_UNDATED_SLICE) {
    return String(PL_UOKIK_FIRST_YEAR);
  }
  const next = sliceKeyOf(slice) + 1;
  return next > currentYear() ? null : String(next);
};

export const plUokikPreviousSlice = (slice: string): string | null => {
  if (slice === PL_UOKIK_UNDATED_SLICE) {
    return null;
  }
  const previous = sliceKeyOf(slice) - 1;
  return previous < PL_UOKIK_FIRST_YEAR
    ? PL_UOKIK_UNDATED_SLICE
    : String(previous);
};

/**
 * The first position whose row sorts at or below `key`, by bisection over the
 * view, one single-row read per step. Refused where the view changes size
 * under it: the positions it compared are then not one view's.
 */
const firstAtOrBelow = async (
  key: number,
  total: number,
  slice: string,
  signal?: AbortSignal,
): Promise<Result<number, AdapterFetchError>> => {
  let low = 1;
  let high = total + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    // Sequential by design: each step's position depends on the last answer.
    const probe = await readView({
      cursor: slice,
      start: middle,
      count: 1,
      reverse: false,
      signal,
    });
    if (Result.isError(probe)) {
      return probe;
    }
    const found = probe.value.rows.at(0);
    if (probe.value.total !== total || found === undefined) {
      return Result.err(
        publisherError(slice, "the view changed size while it was bisected"),
      );
    }
    if (plUokikSortKey(found.row) <= key) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return Result.ok(low);
};

type SliceRange = { first: number; last: number; total: number };

/** Where a slice's rows sit in the view: an empty range where it holds none. */
const locateSlice = async (
  slice: string,
  signal?: AbortSignal,
): Promise<Result<SliceRange, AdapterFetchError>> => {
  const key = sliceKeyOf(slice);
  const probe = await readView({
    cursor: slice,
    start: 1,
    count: 1,
    reverse: false,
    signal,
  });
  if (Result.isError(probe)) {
    return probe;
  }
  const { total } = probe.value;
  const first =
    key === UNDATED_KEY
      ? Result.ok(1)
      : await firstAtOrBelow(key, total, slice, signal);
  if (Result.isError(first)) {
    return first;
  }
  const after = await firstAtOrBelow(key - 1, total, slice, signal);
  if (Result.isError(after)) {
    return after;
  }
  return Result.ok({ first: first.value, last: after.value - 1, total });
};

/**
 * One page of the rows a slice holds, read with the neighbouring row on each
 * side the page borders, which has to sort outside the slice. A page whose
 * borders do not hold is refused, never recorded short.
 */
const listPlUokikSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const located = await locateSlice(slice, signal);
  if (Result.isError(located)) {
    return await Promise.reject(located.error);
  }
  const { first, last, total } = located.value;
  const size = last - first + 1;
  if (size <= 0) {
    return { items: [], totalPages: 0 };
  }
  const totalPages = Math.ceil(size / SLICE_PAGE_ROWS);
  if (page >= totalPages) {
    return { items: [], totalPages };
  }
  const pageFirst = first + page * SLICE_PAGE_ROWS;
  const pageLast = Math.min(last, pageFirst + SLICE_PAGE_ROWS - 1);
  const before = page === 0 && pageFirst > 1;
  const after = pageLast === last && last < total;
  const start = before ? pageFirst - 1 : pageFirst;
  const count = pageLast - pageFirst + 1 + (before ? 1 : 0) + (after ? 1 : 0);
  const read = await readView({
    cursor: slice,
    start,
    count,
    reverse: false,
    signal,
  });
  if (Result.isError(read)) {
    return await Promise.reject(read.error);
  }
  const { rows } = read.value;
  const key = sliceKeyOf(slice);
  const inside = rows.slice(before ? 1 : 0, after ? -1 : undefined);
  const holds =
    read.value.total === total &&
    rows.length === count &&
    (!before ||
      plUokikSortKey(rows[0]?.row ?? normalizePlUokikRow({})) > key) &&
    (!after ||
      plUokikSortKey(rows.at(-1)?.row ?? normalizePlUokikRow({})) < key) &&
    inside.every(({ row }) => plUokikSortKey(row) === key);
  if (!holds) {
    return await Promise.reject(
      publisherError(
        slice,
        `page ${page} of slice ${slice} did not hold its borders; the view moved under it`,
      ),
    );
  }
  return {
    items: inside.map(({ entry, row }) => ({
      identity: plUokikListingIdentity(row),
      payload: entry,
    })),
    totalPages,
  };
};

/** Rebuild a decision from a view row the census stored verbatim. */
const buildPlUokikFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const attempted = await buildPlUokikDecision({
    cursor: normalizePlUokikRow(payload).unid ?? "",
    entry: payload,
    ...(signal === undefined ? {} : { signal }),
  });
  if (Result.isError(attempted)) {
    return await Promise.reject(attempted.error);
  }
  const { built, rulings } = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision, companions: rulings };
    case "unkeyable":
      return { type: "unkeyable" };
    case "detail-unavailable":
      // Storing the view row alone would make the identity held while its
      // page stayed unread, and the decision would leave every later walk.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-uokik build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Total ────────────────────────────────────────────────

/** The view's own size, which every row of it counts. */
const countPlUokikDecisions = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const probe = await readView({
    cursor: "total",
    start: 1,
    count: 1,
    reverse: false,
    signal,
  });
  if (Result.isError(probe)) {
    return probe.error.httpStatus === undefined
      ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
      : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
  }
  return sourceTotalRead(probe.value.total);
};

// ── Adapter ──────────────────────────────────────────────

export const plUokikAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_UOKIK,
  language: PL_UOKIK_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // A window read and up to a few requests per decision behind the
  // two-second gate, one decision file running to megabytes.
  pageTimeoutMs: 5 * 60_000,
  maxCycleMs: 20 * 60_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparsePlUokikStoredRaw,

  sourceSurfaces: PL_UOKIK_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_UOKIK_SOURCE_FIELDS,
    listSourceFields: listPlUokikSourceFields,
  },

  getTotalCount: countPlUokikDecisions,

  reconciliation: {
    firstSlice: PL_UOKIK_UNDATED_SLICE,
    sliceOf: yearOf,
    nextSlice: plUokikNextSlice,
    previousSlice: plUokikPreviousSlice,
    // The current year and the one before it: a decision is published weeks
    // after its date, and one published late lands where the crawl has passed.
    tipWindowDays: 2,
    // A decision whose page failed leaves a row-only stub; unset, it would
    // count as held and its page would never be asked for again.
    heldRequiresDetail: true,
    heldWithoutDetail: plUokikHeldWithoutDetail,
    // A decision whose files are scans, or which has none, is complete on its
    // page: asking again would read the same images.
    // An appeal still before the courts gets its rulings attached to the
    // decision's page; the census reads such a page again on each walk.
    recheckHeld: {
      metadataKey: PL_UOKIK_APPEAL_WATCH_KEY,
      values: [PL_UOKIK_APPEAL_WATCH.AWAITING_RULING],
    },
    heldWithoutDocument: {
      metadataKey: PL_UOKIK_DOCUMENT_ABSENCE_KEY,
      reasons: [
        PL_UOKIK_DOCUMENT_ABSENCE.SCANNED,
        PL_UOKIK_DOCUMENT_ABSENCE.NO_ATTACHMENT,
      ],
    },
    listSlicePage: listPlUokikSlicePage,
    buildDecision: buildPlUokikFromPayload,
  },

  /**
   * The page's own refusals come back as `Err`; this wrapper is for what the
   * fetch layer raises instead — a dropped connection, a cycle abort.
   */
  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plUokikFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_UOKIK, cursor),
      }),
    );
  },
});
