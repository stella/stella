/**
 * Polish Constitutional Tribunal (Trybunał Konstytucyjny) adapter.
 *
 * The Tribunal publishes its rulings through its own portal,
 * ipo.trybunal.gov.pl, a JSF application answering over HTTP/2 only. Four of
 * its pages are used, all of them GET:
 *
 *   /ipo/                  opens a session (`JSESSIONID`)
 *   /ipo/Szukaj?cid=1      builds the default ruling search for the session
 *   /ipo/SzukajDrukuj      that search's print view, 25 rulings a page,
 *                          newest first, paged by `page` (0-based)
 *   /ipo/Sprawa            one case: its record and every ruling in it
 *
 * The default search is narrowed by two cookies the portal reads when it
 * builds it: `Okres` (period) and `RodzajRozstrzygniecia` (stage of the
 * proceedings). `Okres=Since1986` lifts the period to the Tribunal's first
 * ruling, and the three stages together are the whole corpus: `300` the
 * merits review (K, P, SK, U, Kp, Pp, Kpt, W), `700` signalling decisions
 * (S) and `100` the preliminary review of complaints and applications (Ts,
 * Tw, T). A value the portal does not know is answered with a redirect back
 * to the search, never with an empty list.
 *
 * The print view offers no date filter and no ascending order to a GET, and
 * the listing states pages rather than rows. Both walks below are built on
 * that listing alone:
 *
 * - The crawl counts rulings from the OLD end of each stage's listing. New
 *   rulings are added at the newest end, so an offset counted from the other
 *   end does not move when they arrive. Cursor: `<stage>:<m>,<s>,<p>`, the
 *   stage being walked and how many rulings of each stage have been read.
 *   A caught-up stage hands over to the next one, so a crawl at rest rotates
 *   through the three stages and reads each one's new tail.
 * - The reconciliation slice is a decision year. The listing is ordered by
 *   date, so the pages holding a year are found by bisection over page
 *   numbers and read end to end; the slice's pages are the three stages.
 *
 * Overlap with `pl-courts`: SAOS republished this court until 2015-12-09. The
 * two sources keep separate id spaces; {@link plConstitutionalTribunalRulingKeys}
 * are the keys a SAOS row and a row from this portal share when they describe
 * the same ruling, stored as `rulingKeys` on the rows of both.
 */

import { panic, Result } from "better-result";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import { isPolishConstitutionalDocket } from "@stll/api-contract/decision-docket-grammar";
import { readCappedBytes } from "@stll/skills/streaming";

import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
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
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  PL_TK_RULING_FAMILY,
  plConstitutionalTribunalRulingKeys,
} from "@/api/handlers/case-law/ingestion/adapters/pl-tk-ruling-keys";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  listPlTkPageFields,
  parsePlTkText,
  parsePolishDate,
  PL_TK_ORIGIN,
  readPlTkCasePage,
  readPlTkRuling,
} from "@/api/handlers/case-law/ingestion/parsers/pl-tk";
import type {
  PlTkCaseRecord,
  PlTkRuling,
} from "@/api/handlers/case-law/ingestion/parsers/pl-tk";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const PL_TK_BASE = `${PL_TK_ORIGIN}/ipo`;

/**
 * The only origin this adapter may reach. Every URL it fetches is built here
 * from a fixed path and the portal's opaque ids.
 */
const PL_TK_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://ipo.trybunal.gov.pl"],
} as const;

const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(ADAPTER_KEYS.PL_TK);

/** The print view's fixed page size; the portal offers no other to a GET. */
export const PL_TK_PAGE_SIZE = 25;

/**
 * Rulings one crawl page reads. Each costs a case-page request behind the
 * publisher gate, and a case page with a long reasoning takes the portal
 * several seconds to render, so a small batch keeps a page inside its timeout.
 */
const CRAWL_BATCH = 10;

/** Case pages run to 300 KB and render slowly; listings are quicker. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The largest page read. The longest case page seen, K 47/15 with its five
 * rulings and dissents, is 1.5 MB; eight times that is not a case page.
 */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** The only language this source publishes; half of the fallback identity. */
const PL_TK_LANGUAGE = "pl";

const PL_TK_COURT = "Trybunał Konstytucyjny";

const PL_TK_DATE_RANGE = ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_TK].dateRange;

/** The first year the portal lists a ruling in. */
const PL_TK_FIRST_YEAR = PL_TK_DATE_RANGE.fromInclusive.slice(0, 4);

/**
 * Year slices re-walked on the fast cadence. `tipWindowDays` counts slices;
 * two is the current year and the one before it, which is where the portal
 * still adds rulings and replaces their records.
 */
const PL_TK_TIP_WINDOW_SLICES = 2;

/** `Okres`: every ruling from the Tribunal's first, not only since 1997. */
const PERIOD_ALL = "Since1986";

/**
 * The three stages of proceedings the portal files a ruling under, in the
 * crawl's order, with the `RodzajRozstrzygniecia` code each is selected by.
 */
export const PL_TK_STAGES = {
  merits: "300",
  signalling: "700",
  preliminary: "100",
} as const;

export type PlTkStage = keyof typeof PL_TK_STAGES;

const STAGE_ORDER = [
  "merits",
  "signalling",
  "preliminary",
] as const satisfies readonly PlTkStage[];

const isPlTkStage = (value: unknown): value is PlTkStage =>
  typeof value === "string" && Object.hasOwn(PL_TK_STAGES, value);

// ── Requests ─────────────────────────────────────────────

const tkError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `ipo.trybunal.gov.pl: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_TK,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

type TkResponse = {
  status: number;
  body: string;
  url: string;
  setCookies: string[];
};

/**
 * One GET to the portal.
 *
 * The host answers HTTP/2 alone: an HTTP/1.1 request is accepted and never
 * answered, which reads as a timeout rather than a refusal. A redirect is
 * never followed; it comes back as a response with the redirect's status, so
 * the caller decides what a redirect from that page means.
 */
const requestTk = async ({
  cookie,
  path,
  signal,
}: {
  cookie: string | undefined;
  path: string;
  signal: AbortSignal | undefined;
}): Promise<Result<TkResponse, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_TK_HOST_POLICY,
    rawUrl: `${PL_TK_BASE}${path}`,
  });
  if (target === null) {
    return panic("ipo.trybunal.gov.pl request escaped the publisher origin");
  }
  const requested = await Result.tryPromise({
    try: async () =>
      await fetchWithRetry(
        target.toString(),
        {
          protocol: "http2",
          redirect: "error",
          headers: {
            Accept: "text/html",
            ...(cookie === undefined ? {} : { Cookie: cookie }),
          },
        },
        {
          adapterKey: ADAPTER_KEYS.PL_TK,
          signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(requested)) {
    if (isRefusedRedirect(requested.error)) {
      return Result.ok({
        status: REFUSED_REDIRECT_STATUS,
        body: "",
        url: target.toString(),
        setCookies: [],
      });
    }
    return Result.err(
      new AdapterFetchError({
        message: `ipo.trybunal.gov.pl: ${path} failed`,
        adapterKey: ADAPTER_KEYS.PL_TK,
        cursor: path,
        cause: requested.error,
      }),
    );
  }
  const response = requested.value;
  const bytes =
    response.body === null
      ? new Uint8Array()
      : await readCappedBytes(response.body, MAX_RESPONSE_BYTES);
  if (bytes === null) {
    return Result.err(
      tkError(path, `the page ${path} exceeded ${MAX_RESPONSE_BYTES} bytes`),
    );
  }
  return Result.ok({
    status: response.status,
    body: new TextDecoder().decode(bytes),
    url: target.toString(),
    setCookies: response.headers.getSetCookie(),
  });
};

/** The status a redirect the fetch refused to follow is reported with. */
const REFUSED_REDIRECT_STATUS = 302;

/** Bun's refusal of a redirect under `redirect: "error"`. */
const isRefusedRedirect = (error: unknown): boolean =>
  isRecord(error) && error["code"] === "UnexpectedRedirect";

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

const cookieValue = (
  setCookies: readonly string[],
  name: string,
): string | undefined => {
  for (const header of setCookies) {
    const [pair] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (
      pair !== undefined &&
      separator > 0 &&
      pair.slice(0, separator).trim() === name
    ) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
};

/** Mutable: a walk that loses its session opens another in place. */
type Session = { sessionId: string };

/** A fresh portal session; everything else the portal serves needs one. */
const openSession = async (
  cursor: string,
  signal: AbortSignal | undefined,
): Promise<Result<Session, AdapterFetchError>> => {
  const landed = await requestTk({
    cookie: undefined,
    path: "/",
    signal,
  });
  if (Result.isError(landed)) {
    return landed;
  }
  const landing = landed.value;
  const sessionId = cookieValue(landing.setCookies, "JSESSIONID");
  if (landing.status !== 200 || sessionId === undefined) {
    return Result.err(
      tkError(cursor, `the portal opened no session (${landing.status})`),
    );
  }
  return Result.ok({ sessionId });
};

const sessionCookie = (session: Session, stage?: PlTkStage): string =>
  stage === undefined
    ? `JSESSIONID=${session.sessionId}`
    : `JSESSIONID=${session.sessionId}; Okres=${PERIOD_ALL}; RodzajRozstrzygniecia=${PL_TK_STAGES[stage]}`;

/**
 * Build the session's search for one stage. The portal echoes the filter
 * cookies it applied; a value it replaced is a search over a different
 * subset than asked for, which would be listed as if it were this stage.
 */
const selectStage = async (
  session: Session,
  stage: PlTkStage,
  cursor: string,
  signal: AbortSignal | undefined,
): Promise<Result<void, AdapterFetchError>> => {
  const searched = await requestTk({
    cookie: sessionCookie(session, stage),
    path: "/Szukaj?cid=1",
    signal,
  });
  if (Result.isError(searched)) {
    return searched;
  }
  const search = searched.value;
  if (search.status !== 200) {
    return Result.err(
      tkError(
        cursor,
        `the ${stage} search answered ${search.status}`,
        search.status,
      ),
    );
  }
  const period = cookieValue(search.setCookies, "Okres");
  const code = cookieValue(search.setCookies, "RodzajRozstrzygniecia");
  if (
    (period !== undefined && period !== PERIOD_ALL) ||
    (code !== undefined && code !== PL_TK_STAGES[stage])
  ) {
    return Result.err(
      tkError(cursor, `the portal replaced the ${stage} filter`),
    );
  }
  return Result.ok(undefined);
};

// ── Listing ──────────────────────────────────────────────

/** One ruling as the print view lists it. */
export type PlTkListingRow = {
  stage: PlTkStage;
  /**
   * The portal's document id, or a content-addressed audit id for a row
   * that states none (see {@link PL_TK_QUARANTINE_PREFIX}).
   */
  documentId: string;
  caseId: string | undefined;
  caseNumber: string | undefined;
  decisionForm: string | undefined;
  decisionDate: string | undefined;
  subject: string | undefined;
  /** The row's markup as the print view served it. */
  rowHtml: string | undefined;
  /** Set where the row lacked a field every ruling's row states. */
  defect: "unparseable-row" | undefined;
};

/**
 * The identity of a listed row the adapter could not read an id from: the
 * row's own markup, hashed. It is counted and stored like any other row, so
 * a markup change the parser does not know shows up as held rows with this
 * prefix rather than as rulings that were never listed.
 */
export const PL_TK_QUARANTINE_PREFIX = "pl-tk-quarantine:";

export type PlTkListingPage = {
  /** 1-based, as the portal prints it. */
  page: number;
  totalPages: number;
  rows: PlTkListingRow[];
};

const LISTING_PAGER = /Strona wyników:\s*(?<page>\d+)\s*z\s*(?<total>\d+)/u;
const LISTING_DATE_MARK = " z dnia ";

/**
 * `Wyrok z dnia 13 sierpnia 2026 r.` as its form and its date, from text
 * whose whitespace is already collapsed.
 */
const splitListingLine = (
  line: string,
): { form: string; date: string } | undefined => {
  const at = line.indexOf(LISTING_DATE_MARK);
  const tail =
    at === -1 ? "" : line.slice(at + LISTING_DATE_MARK.length).trim();
  if (at === -1 || at === 0 || !tail.endsWith("r.")) {
    return undefined;
  }
  return { form: line.slice(0, at).trim(), date: tail.slice(0, -2).trim() };
};

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * Attributes the print view writes from a row's position on the page: the
 * row index (`data-ri`), ids and names numbered by it, and the even/odd
 * striping class. They change as new rulings push a row down the listing.
 */
const POSITIONAL_ATTRIBUTES = ["data-ri", "id", "name", "class"] as const;

/**
 * A row's markup without its position, which is what its audit id hashes:
 * the same unreadable row keeps one identity wherever the listing puts it.
 */
const positionFreeRow = ($: cheerio.CheerioAPI, row: AnyNode): string => {
  const copy = $(row).clone();
  for (const element of [
    copy,
    ...copy
      .find("*")
      .toArray()
      .map((node) => $(node)),
  ]) {
    for (const attribute of POSITIONAL_ATTRIBUTES) {
      element.removeAttr(attribute);
    }
  }
  return collapse($.html(copy));
};

/**
 * One print-view page, or `null` for a page that is not one: the portal
 * answers a lapsed session with its search shell, and reading that as an
 * empty listing would end a walk early.
 */
export const parsePlTkListingPage = (
  html: string,
  stage: PlTkStage,
): PlTkListingPage | null => {
  const $ = cheerio.load(html);
  const body = $('[id="wyszukiwanie:dataTable_data"]');
  if (body.length === 0) {
    return null;
  }
  if (body.children("tr.ui-datatable-empty-message").length > 0) {
    return { page: 1, totalPages: 0, rows: [] };
  }
  const pager = LISTING_PAGER.exec($("body").text())?.groups;
  const page = Number(pager?.["page"]);
  const totalPages = Number(pager?.["total"]);
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(totalPages)) {
    return null;
  }
  const rows = body
    .children("tr")
    .toArray()
    .map((row): PlTkListingRow => {
      const rowHtml = $.html(row);
      const cell = $(row).find('[id$=":dokument_:dokument"]').first();
      const link = cell.find('a[href*="Sprawa?"]').first();
      const href = link.attr("href");
      const params =
        href === undefined
          ? undefined
          : URL.parse(href, `${PL_TK_BASE}/`)?.searchParams;
      const documentId = params?.get("dokument") ?? undefined;
      const caseNumber = collapse(cell.find(".sygnatura").first().text());
      const subjectNode = cell.find('span[style*="italic"]');
      const subject = collapse(subjectNode.text());
      const lineNode = cell.clone();
      lineNode.find("a, span").remove();
      const line = splitListingLine(collapse(lineNode.text()));
      const form = line?.form;
      const persistableId =
        documentId !== undefined &&
        documentId.length > 0 &&
        isPersistableSourceDocumentId(documentId)
          ? documentId
          : undefined;
      const defect =
        persistableId === undefined ||
        caseNumber.length === 0 ||
        form === undefined
          ? "unparseable-row"
          : undefined;
      // Never dropped: the row is counted in the page, and a page that came
      // back one row short would read as the end of the listing.
      return {
        stage,
        documentId:
          persistableId ??
          `${PL_TK_QUARANTINE_PREFIX}${hashContent(positionFreeRow($, row))}`,
        caseId: params?.get("sprawa") ?? undefined,
        caseNumber: caseNumber.length === 0 ? undefined : caseNumber,
        decisionForm: form,
        decisionDate: parsePolishDate(line?.date ?? ""),
        subject: subject.length === 0 ? undefined : subject.replace(/\.$/u, ""),
        rowHtml,
        defect,
      };
    });
  return { page, totalPages, rows };
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A stored or parked listing row, read leniently and re-checked. */
export const normalizePlTkListingRow = (
  value: Record<string, unknown>,
): PlTkListingRow | null => {
  const stage = value["stage"];
  const documentId = optionalString(value["documentId"]);
  if (!isPlTkStage(stage) || documentId === undefined) {
    return null;
  }
  return {
    stage,
    documentId,
    caseId: optionalString(value["caseId"]),
    caseNumber: optionalString(value["caseNumber"]),
    decisionForm: optionalString(value["decisionForm"]),
    decisionDate: optionalString(value["decisionDate"]),
    subject: optionalString(value["subject"]),
    rowHtml: optionalString(value["rowHtml"]),
    defect:
      value["defect"] === "unparseable-row" ? "unparseable-row" : undefined,
  };
};

type StageListing = {
  session: Session;
  stage: PlTkStage;
  cursor: string;
  signal: AbortSignal | undefined;
  /** Pages read so far, by 0-based index. */
  pages: Map<number, { page: PlTkListingPage; url: string }>;
};

const readListingPage = async (
  listing: StageListing,
  index: number,
): Promise<
  Result<{ page: PlTkListingPage; url: string }, AdapterFetchError>
> => {
  const cached = listing.pages.get(index);
  if (cached !== undefined) {
    return Result.ok(cached);
  }
  const requested = await requestTk({
    cookie: sessionCookie(listing.session, listing.stage),
    path: `/SzukajDrukuj?cid=1&page=${index}`,
    signal: listing.signal,
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const response = requested.value;
  const page =
    response.status === 200
      ? parsePlTkListingPage(response.body, listing.stage)
      : null;
  if (page === null) {
    return Result.err(
      tkError(
        listing.cursor,
        `the ${listing.stage} listing page ${index} is unreadable (${response.status})`,
        response.status,
      ),
    );
  }
  // Every page but the last is full; anything else means the page size this
  // walk counts in is no longer the portal's.
  if (page.page < page.totalPages && page.rows.length !== PL_TK_PAGE_SIZE) {
    return Result.err(
      tkError(
        listing.cursor,
        `the ${listing.stage} listing page ${index} holds ${page.rows.length} rows`,
      ),
    );
  }
  const read = { page, url: response.url };
  listing.pages.set(index, read);
  return Result.ok(read);
};

const openStageListing = async (
  stage: PlTkStage,
  cursor: string,
  signal: AbortSignal | undefined,
): Promise<Result<StageListing, AdapterFetchError>> => {
  const session = await openSession(cursor, signal);
  if (Result.isError(session)) {
    return session;
  }
  const selected = await selectStage(session.value, stage, cursor, signal);
  if (Result.isError(selected)) {
    return selected;
  }
  return Result.ok({
    session: session.value,
    stage,
    cursor,
    signal,
    pages: new Map(),
  });
};

type StageSize = { totalPages: number; total: number; firstUrl: string };

/** How many rulings a stage lists: every page full but the last. */
const stageSize = async (
  listing: StageListing,
): Promise<Result<StageSize, AdapterFetchError>> => {
  const first = await readListingPage(listing, 0);
  if (Result.isError(first)) {
    return first;
  }
  const { totalPages } = first.value.page;
  if (totalPages <= 1) {
    return Result.ok({
      totalPages,
      total: first.value.page.rows.length,
      firstUrl: first.value.url,
    });
  }
  const last = await readListingPage(listing, totalPages - 1);
  if (Result.isError(last)) {
    return last;
  }
  return Result.ok({
    totalPages,
    total: PL_TK_PAGE_SIZE * (totalPages - 1) + last.value.page.rows.length,
    firstUrl: first.value.url,
  });
};

const countStage = async (
  stage: PlTkStage,
  signal: AbortSignal | undefined,
): Promise<Result<StageSize, AdapterFetchError>> => {
  const listing = await openStageListing(stage, stage, signal);
  return Result.isError(listing) ? listing : await stageSize(listing.value);
};

// ── Normalization ────────────────────────────────────────

/**
 * Decision types in the court's own language: the head noun of the portal's
 * `Rodzaj orzeczenia`, whose full wording stays on the row as `decisionForm`
 * ("Postanowienie - umorzenie", "Postanowienie o odmowie").
 */
const PL_TK_DECISION_TYPES = [
  "wyrok",
  "postanowienie",
  "uchwała",
  "orzeczenie",
  "rozstrzygnięcie",
  "sygnalizacja",
] as const;

export type PlTkDecisionType = (typeof PL_TK_DECISION_TYPES)[number];

export const plTkDecisionType = (
  form: string | undefined,
): PlTkDecisionType | undefined => {
  if (form === undefined) {
    return undefined;
  }
  const head = form
    .toLocaleLowerCase("pl-PL")
    .split(/[\s-]+/u)
    .at(0);
  const matched = PL_TK_DECISION_TYPES.find((type) => type === head);
  if (matched === undefined) {
    logger.warn("case_law.ingestion.decision_type_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_TK,
      decisionForm: form,
    });
  }
  return matched;
};

// Every kind this portal files has a family the key names it by.
PL_TK_RULING_FAMILY satisfies Record<PlTkDecisionType, string>;

/**
 * The courts this portal is known to publish, as a ruling's text names them.
 * The portal is the Tribunal's own, and every ruling it has served names the
 * Tribunal; a name outside this list is a ruling that is not stored as one.
 */
const PL_TK_KNOWN_COURTS = new Set([PL_TK_COURT]);

export type PlTkCourt =
  | { type: "stated"; court: string }
  | { type: "unknown"; courtAsPrinted: string | undefined };

/**
 * The deciding court, read off the record: the bench line of the ruling's
 * text where the page was served, else its docket, where that is a
 * Tribunal docket by the shared Polish docket grammar.
 */
export const plTkDecidingCourt = ({
  caseNumber,
  courtAsPrinted,
}: {
  caseNumber: string | undefined;
  courtAsPrinted: string | undefined;
}): PlTkCourt => {
  if (courtAsPrinted !== undefined) {
    return PL_TK_KNOWN_COURTS.has(courtAsPrinted)
      ? { type: "stated", court: courtAsPrinted }
      : { type: "unknown", courtAsPrinted };
  }
  return caseNumber !== undefined && isPolishConstitutionalDocket(caseNumber)
    ? { type: "stated", court: PL_TK_COURT }
    : { type: "unknown", courtAsPrinted: undefined };
};

/**
 * The identity the ingest stores a listed ruling under: the portal's own
 * document id. A docket names a case, and a case holds several rulings.
 */
export const plTkListingIdentity = (
  row: PlTkListingRow | null,
): ListingIdentity =>
  row !== null && isPersistableSourceDocumentId(row.documentId)
    ? { type: "document", sourceDocumentId: row.documentId }
    : { type: "unidentifiable" };

const casePagePath = (row: PlTkListingRow): string =>
  row.caseId === undefined
    ? `/Sprawa?cid=1&dokument=${encodeURIComponent(row.documentId)}`
    : `/Sprawa?cid=1&dokument=${encodeURIComponent(row.documentId)}&sprawa=${encodeURIComponent(row.caseId)}`;

const PRESIDING = /^przewodnicząc/iu;
const RAPPORTEUR = /^sprawozdawc/iu;

/**
 * The bench as the ruling's table prints it, and the dissenters its text
 * names. A judge is listed once per role.
 */
export const plTkJudges = (ruling: PlTkRuling): DecisionJudgeInput[] => {
  const judges: DecisionJudgeInput[] = [];
  const seen = new Set<string>();
  const add = (judge: DecisionJudgeInput): void => {
    const key = `${judge.role}\u0000${judge.nameAsPrinted}`;
    if (!seen.has(key)) {
      seen.add(key);
      judges.push(judge);
    }
  };
  for (const member of ruling.panel) {
    const presiding = member.functions.some((name) => PRESIDING.test(name));
    const rapporteur = member.functions.some((name) => RAPPORTEUR.test(name));
    if (presiding) {
      add({ role: DECISION_JUDGE_ROLE.PRESIDING, nameAsPrinted: member.name });
    }
    if (rapporteur) {
      add({ role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: member.name });
    }
    if (!presiding && !rapporteur) {
      add({
        role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
        nameAsPrinted: member.name,
      });
    }
  }
  for (const dissent of ruling.dissents) {
    for (const name of dissent.judges) {
      add({ role: DECISION_JUDGE_ROLE.DISSENTING, nameAsPrinted: name });
    }
  }
  return judges;
};

/** A list the row states, or nothing: an empty list is not a statement. */
const statedList = <T>(values: readonly T[]): readonly T[] | undefined =>
  values.length === 0 ? undefined : values;

const recordMetadata = (
  record: PlTkCaseRecord | undefined,
): Record<string, unknown> =>
  record === undefined
    ? {}
    : {
        filedDate: record.filedDate,
        filedStkDate: record.filedStkDate,
        originatesFrom: statedList(record.originatesFrom),
        transferredTo: statedList(record.transferredTo),
        joinedCases: statedList(record.joinedCases),
        signalledCase: statedList(record.signalledCase),
        parties: statedList(record.parties),
        challengedProvisions: statedList(record.challengedProvisions),
        constitutionalStandards: statedList(record.constitutionalStandards),
        caseDocuments: statedList(record.caseDocuments),
      };

const rulingMetadata = (ruling: PlTkRuling | null): Record<string, unknown> =>
  ruling === null
    ? {}
    : {
        publications: statedList(ruling.publications),
        publicationNote: ruling.note,
        panel: statedList(ruling.panel),
        dissentingOpinions: statedList(
          ruling.dissents.map(({ authorsAsPrinted }) => authorsAsPrinted),
        ),
        footnotes: statedList(ruling.footnotes),
        wordDocumentUrl: ruling.wordDocumentUrl,
      };

/** Metadata without the keys a source left blank. */
const definedEntries = (
  metadata: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );

/** The parts of the stored raw envelope; a replay reads exactly these. */
export const PL_TK_RAW_PART = {
  LISTING: "listing",
  CASE_PAGE: "case-page",
} as const;

export type PlTkBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No document id to key on; nothing can store this row. */
  | { type: "unkeyable" }
  /** The case page held no text for the listed ruling. */
  | { type: "detail-unavailable"; decision: IngestionResult };

export type AssemblePlTkDecisionOptions = {
  row: PlTkListingRow;
  /** The case page, where one was read. */
  casePage: string | undefined;
  rawParts: SourceRawParts;
};

/**
 * Build one ruling from the responses already in hand.
 *
 * No I/O: the crawl, the reconciliation and a replay of a stored envelope
 * all reach this with the same two payloads, so none of them can key or
 * parse a ruling differently from the others.
 */
export const assemblePlTkDecision = ({
  casePage,
  rawParts,
  row,
}: AssemblePlTkDecisionOptions): PlTkBuildResult => {
  const id = row.documentId;
  if (!isPersistableSourceDocumentId(id)) {
    return { type: "unkeyable" };
  }
  const page = casePage === undefined ? null : readPlTkCasePage(casePage);
  const ruling = casePage === undefined ? null : readPlTkRuling(casePage, id);
  const statedCaseNumber = page?.record.caseNumber ?? row.caseNumber;
  // A row that states no docket still has to be stored under one; the audit
  // id stands in and is flagged as a placeholder.
  const caseNumber = statedCaseNumber ?? id;
  const decisionForm = ruling?.decisionForm ?? row.decisionForm;
  const deciding = plTkDecidingCourt({
    caseNumber: statedCaseNumber,
    courtAsPrinted: ruling?.courtAsPrinted,
  });
  if (deciding.type === "unknown") {
    logger.warn("case_law.ingestion.court_not_stated", {
      adapterKey: ADAPTER_KEYS.PL_TK,
      caseNumber,
      courtAsPrinted: deciding.courtAsPrinted ?? "",
    });
  }
  // `court` is a required column. A ruling whose court is not established
  // is quarantined: kept listing-only and unpublished with the reason, under
  // the publisher's name, rather than published as the Tribunal's.
  const court = deciding.type === "stated" ? deciding.court : PL_TK_COURT;
  const decisionType = plTkDecisionType(decisionForm);
  const decisionDate = ruling?.decisionDate ?? row.decisionDate;
  const sourceUrl = `${PL_TK_BASE}${casePagePath(row)}`;
  const documentUrl = ruling?.wordDocumentUrl;

  const parsed =
    ruling?.textHtml === undefined
      ? null
      : Result.try({
          try: () =>
            parsePlTkText({
              caseNumber,
              court,
              decisionDate,
              decisionType,
              documentId: id,
              sourceUrl,
              documentUrl,
              textHtml: ruling.textHtml ?? "",
            }),
          catch: errorTag,
        });
  if (parsed !== null && Result.isError(parsed)) {
    // The case page is stored verbatim below, so the text is recoverable by
    // re-parsing it rather than by asking the portal again.
    logger.warn("case_law.ingestion.document_parse_failed", {
      adapterKey: ADAPTER_KEYS.PL_TK,
      caseNumber,
      "error.type": parsed.error,
    });
  }
  const document = parsed !== null && Result.isOk(parsed) ? parsed.value : null;
  const documentAst: DocumentAst | EmptyAst =
    document?.documentAst ?? EMPTY_AST;
  const sourceRaw = encodeSourceRawEnvelope(rawParts);
  const hasText = document !== null && deciding.type === "stated";

  const decision: IngestionResult = {
    caseNumber,
    ...(statedCaseNumber === undefined
      ? { caseNumberIsPlaceholder: true }
      : {}),
    sourceDocumentId: id,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_TK].country,
    language: PL_TK_LANGUAGE,
    decisionDate,
    decisionType,
    fulltext: document?.fulltext,
    ...(hasText ? {} : { isListingOnly: true }),
    ...(ruling === null ? {} : { judges: plTkJudges(ruling) }),
    sourceUrl,
    documentUrl,
    // The portal prints no abstract or headnote beside the ruling; the
    // subject line it states is kept as metadata.
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata(
      definedEntries({
        documentId: id,
        caseId: row.caseId,
        stage: row.stage,
        listingDefect: row.defect,
        ...(deciding.type === "unknown"
          ? {
              quarantineReason: "court-not-stated",
              courtAsPrinted: deciding.courtAsPrinted,
            }
          : {}),
        decisionForm,
        subject: ruling?.subject ?? row.subject,
        ...recordMetadata(page?.record),
        ...rulingMetadata(ruling),
        rulingKeys:
          statedCaseNumber === undefined
            ? undefined
            : plConstitutionalTribunalRulingKeys({
                caseNumber: statedCaseNumber,
                court,
                decisionDate,
                decisionType,
              }),
      }),
    ),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_TK],
    documentAst,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return hasText
    ? { type: "built", decision }
    : { type: "detail-unavailable", decision };
};

/** The envelope parts for a row and the case page it was read with. */
export const plTkRawPartsOf = (
  row: PlTkListingRow,
  casePage: string | undefined,
): SourceRawParts => ({
  [PL_TK_RAW_PART.LISTING]: JSON.stringify(row),
  ...(casePage === undefined ? {} : { [PL_TK_RAW_PART.CASE_PAGE]: casePage }),
});

/**
 * Fetch a listed ruling's case page and assemble it. A refused request is
 * the ruling's failure, not its absence, so it comes back as an `Err`.
 */
const buildPlTkDecision = async ({
  cursor,
  pageCache,
  row,
  session,
  signal,
}: {
  cursor: string;
  /** Case pages already read in this call, by case page path. */
  pageCache: Map<string, string>;
  row: PlTkListingRow;
  session: Session;
  signal: AbortSignal | undefined;
}): Promise<Result<PlTkBuildResult, AdapterFetchError>> => {
  if (!isPersistableSourceDocumentId(row.documentId)) {
    return Result.ok({ type: "unkeyable" });
  }
  const docket = row.caseNumber ?? row.documentId;
  const listingOnly = (): Result<PlTkBuildResult, AdapterFetchError> =>
    Result.ok(
      assemblePlTkDecision({
        row,
        casePage: undefined,
        rawParts: plTkRawPartsOf(row, undefined),
      }),
    );
  if (row.documentId.startsWith(PL_TK_QUARANTINE_PREFIX)) {
    // No id to address a case page by: the verbatim row is what is kept.
    return listingOnly();
  }
  const path = casePagePath(row);
  let casePage =
    row.caseId === undefined ? undefined : pageCache.get(row.caseId);
  if (casePage === undefined) {
    const first = await requestTk({
      cookie: sessionCookie(session),
      path,
      signal,
    });
    if (Result.isError(first)) {
      return first;
    }
    let response = first.value;
    if (isRedirect(response.status)) {
      // A redirect is the portal's error page for a case it cannot render,
      // or its answer to a session it no longer holds: a slow batch can
      // outlive one. A fresh session tells them apart.
      const reopened = await openSession(cursor, signal);
      if (Result.isError(reopened)) {
        return reopened;
      }
      session.sessionId = reopened.value.sessionId;
      const retried = await requestTk({
        cookie: sessionCookie(session),
        path,
        signal,
      });
      if (Result.isError(retried)) {
        return retried;
      }
      response = retried.value;
    }
    if (isRedirect(response.status)) {
      // Redirected with a fresh session too: the case, not the session. The
      // row is kept listing-only, which the reconciliation does not count as
      // held, so a later walk asks again.
      logger.warn("case_law.ingestion.document_unavailable", {
        adapterKey: ADAPTER_KEYS.PL_TK,
        caseNumber: docket,
        documentId: row.documentId,
      });
      return listingOnly();
    }
    if (response.status !== 200) {
      return Result.err(
        tkError(
          cursor,
          `the case page for ${docket} answered ${response.status}`,
          response.status,
        ),
      );
    }
    if (readPlTkCasePage(response.body) === null) {
      // A 200 that is not a case page is the portal's shell for a session
      // it no longer holds: the ruling was not refused, it was not served.
      return Result.err(
        tkError(cursor, `the case page for ${docket} is not a case`),
      );
    }
    casePage = response.body;
    if (row.caseId !== undefined) {
      pageCache.set(row.caseId, casePage);
    }
  }
  return Result.ok(
    assemblePlTkDecision({
      row,
      casePage,
      rawParts: plTkRawPartsOf(row, casePage),
    }),
  );
};

// ── Replay ───────────────────────────────────────────────

const reparsePlTkStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: PL_TK_RAW_PART.LISTING,
    identityOf: (listing) => optionalString(listing["documentId"]),
  });
  if (read.type === "rejected") {
    return read;
  }
  const row = normalizePlTkListingRow(read.listing);
  if (row === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "the stored listing row lacks its stage or id",
    };
  }
  const built = assemblePlTkDecision({
    row,
    casePage: read.parts[PL_TK_RAW_PART.CASE_PAGE],
    rawParts: read.parts,
  });
  return built.type === "unkeyable"
    ? {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: "the stored listing row states no document id",
      }
    : { type: "parsed", result: built.decision };
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every label the case page prints: the case record's fields and panels,
 * then each ruling tab's fields and its bench table.
 */
const SOURCE_FIELDS = [
  "Sygnatura",
  "Data wpływu do TK",
  "Data wpływu do STK",
  "Pochodzi z",
  "Przeniesiona do",
  "Sprawy dołączone",
  "Sygnalizacja w sprawie",
  "Podmiot w sprawie",
  "Przedmiot sprawy",
  "Wzorce",
  "Dokumenty w sprawie",
  "Rodzaj orzeczenia",
  "Data",
  "Dotyczy",
  "Miejsce publikacji",
  "Skład",
] as const;

const PL_TK_SOURCE_FIELDS = {
  Sygnatura: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "Data wpływu do TK": {
    disposition: "stored",
    target: { type: "metadata", key: "filedDate" },
  },
  "Data wpływu do STK": {
    disposition: "stored",
    target: { type: "metadata", key: "filedStkDate" },
  },
  "Pochodzi z": {
    disposition: "stored",
    target: { type: "metadata", key: "originatesFrom" },
  },
  "Przeniesiona do": {
    disposition: "stored",
    target: { type: "metadata", key: "transferredTo" },
  },
  "Sprawy dołączone": {
    disposition: "stored",
    target: { type: "metadata", key: "joinedCases" },
  },
  "Sygnalizacja w sprawie": {
    disposition: "stored",
    target: { type: "metadata", key: "signalledCase" },
  },
  "Podmiot w sprawie": {
    disposition: "stored",
    target: { type: "metadata", key: "parties" },
  },
  "Przedmiot sprawy": {
    disposition: "stored",
    target: { type: "metadata", key: "challengedProvisions" },
  },
  Wzorce: {
    disposition: "stored",
    target: { type: "metadata", key: "constitutionalStandards" },
  },
  "Dokumenty w sprawie": {
    disposition: "stored",
    target: { type: "metadata", key: "caseDocuments" },
  },
  "Rodzaj orzeczenia": {
    disposition: "stored",
    target: { type: "metadata", key: "decisionForm" },
  },
  Data: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  Dotyczy: {
    disposition: "stored",
    target: { type: "metadata", key: "subject" },
  },
  "Miejsce publikacji": {
    disposition: "stored",
    target: { type: "metadata", key: "publications" },
  },
  Skład: { disposition: "stored", target: { type: "result", key: "judges" } },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

const listPlTkSourceFields = (parts: SourceRawParts): readonly string[] => {
  const page = parts[PL_TK_RAW_PART.CASE_PAGE];
  return page === undefined ? [] : listPlTkPageFields(page);
};

/**
 * Every page the portal serves about a ruling, and whether the row keeps it.
 */
const SOURCE_SURFACES = [
  "listing",
  "case-page",
  "word-document",
  "case-filings",
  "official-reports",
  "dissent-search",
  "case-search",
] as const;

const PL_TK_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(PL_TK_RAW_PART.LISTING),
    "case-page": storedSourceSurface(PL_TK_RAW_PART.CASE_PAGE),
    "word-document": excludedSourceSurface(
      "the ruling rendered as a Word file; the case page carries the same text verbatim and the row keeps the download address",
    ),
    "case-filings": excludedSourceSurface(
      "the parties' filings and hearing transcripts, not the ruling; the row keeps their titles and addresses",
    ),
    "official-reports": excludedSourceSurface(
      "the official reports on another host; the row keeps the citation and its address from the case page",
    ),
    "dissent-search": excludedSourceSurface(
      "a corpus-wide index of dissenting opinions whose texts the case page already carries",
    ),
    "case-search": excludedSourceSurface(
      "lists cases rather than rulings; each ruling it reaches is listed by the ruling search",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Crawl cursor ─────────────────────────────────────────

export type PlTkCursor = {
  stage: PlTkStage;
  /** Rulings read from the old end of each stage's listing. */
  read: Record<PlTkStage, number>;
};

const CURSOR_PATTERN =
  /^(?<stage>[a-z]+):(?<merits>\d+),(?<signalling>\d+),(?<preliminary>\d+)$/u;

const START_CURSOR: PlTkCursor = {
  stage: "merits",
  read: { merits: 0, signalling: 0, preliminary: 0 },
};

export const parsePlTkCursor = (cursor: string | null): PlTkCursor => {
  const groups =
    cursor === null ? undefined : CURSOR_PATTERN.exec(cursor)?.groups;
  const stage = groups?.["stage"];
  if (groups === undefined || !isPlTkStage(stage)) {
    return START_CURSOR;
  }
  const count = (name: PlTkStage): number => {
    const value = Number(groups[name]);
    return Number.isSafeInteger(value) ? value : 0;
  };
  return {
    stage,
    read: {
      merits: count("merits"),
      signalling: count("signalling"),
      preliminary: count("preliminary"),
    },
  };
};

export const encodePlTkCursor = ({ read, stage }: PlTkCursor): string =>
  `${stage}:${read.merits},${read.signalling},${read.preliminary}`;

const stageAfter = (stage: PlTkStage): PlTkStage =>
  STAGE_ORDER[(STAGE_ORDER.indexOf(stage) + 1) % STAGE_ORDER.length] ??
  "merits";

/**
 * Which rows of the newest-first listing the next batch is: counting `read`
 * rulings from the old end, the next one sits at index `total - 1 - read`,
 * and the batch runs back towards the newest end without leaving its page.
 */
export const plTkBatchWindow = ({
  batch,
  read,
  total,
}: {
  batch: number;
  read: number;
  total: number;
}): { page: number; from: number; to: number } | null => {
  if (read >= total) {
    return null;
  }
  const oldest = total - 1 - read;
  const page = Math.floor(oldest / PL_TK_PAGE_SIZE);
  const firstOnPage = page * PL_TK_PAGE_SIZE;
  const newest = Math.max(firstOnPage, oldest - batch + 1);
  // Row offsets within the page, oldest first.
  return { page, from: oldest - firstOnPage, to: newest - firstOnPage };
};

const plTkFetchPage = async (
  cursorText: string | null,
  signal: AbortSignal | undefined,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const cursor = parsePlTkCursor(cursorText);
  const { stage } = cursor;
  const label = encodePlTkCursor(cursor);
  const listing = await openStageListing(stage, label, signal);
  if (Result.isError(listing)) {
    return listing;
  }
  const size = await stageSize(listing.value);
  if (Result.isError(size)) {
    return size;
  }
  const { total, firstUrl } = size.value;
  // The listing shrank below what was read: rulings were withdrawn. Counting
  // from the old end, what is left is still read; hold at the new total.
  const read = Math.min(cursor.read[stage], total);
  const window = plTkBatchWindow({ batch: CRAWL_BATCH, read, total });
  if (window === null) {
    // Caught up on this stage: hand over, so the crawl at rest rotates
    // through the stages and re-reads only each one's newest end.
    return Result.ok({
      decisions: [],
      sourceUrl: firstUrl,
      nextCursor: encodePlTkCursor({
        stage: stageAfter(stage),
        read: { ...cursor.read, [stage]: read },
      }),
    });
  }

  const listed = await readListingPage(listing.value, window.page);
  if (Result.isError(listed)) {
    return listed;
  }
  const decisions: IngestionResult[] = [];
  const pageCache = new Map<string, string>();
  let consumed = 0;
  for (let offset = window.from; offset >= window.to; offset -= 1) {
    if (signal?.aborted) {
      break;
    }
    const row = listed.value.page.rows[offset];
    if (row === undefined) {
      return Result.err(
        tkError(
          label,
          `the ${stage} listing has no row ${offset} on page ${window.page}`,
        ),
      );
    }
    const built = await buildPlTkDecision({
      cursor: label,
      pageCache,
      row,
      session: listing.value.session,
      signal,
    });
    if (Result.isError(built)) {
      return built;
    }
    const outcome = built.value;
    switch (outcome.type) {
      case "unkeyable":
        break;
      // The cursor moves past the ruling either way, so the crawl keeps the
      // listing-only row; the reconciliation refuses one.
      case "detail-unavailable":
      case "built":
        decisions.push(outcome.decision);
        break;
      default: {
        outcome satisfies never;
        return panic(
          `Unhandled pl-tk build result: ${JSON.stringify(outcome)}`,
        );
      }
    }
    consumed += 1;
  }

  return Result.ok({
    decisions,
    sourceUrl: listed.value.url,
    nextCursor: encodePlTkCursor({
      stage,
      read: { ...cursor.read, [stage]: read + consumed },
    }),
  });
};

// ── Reconciliation ───────────────────────────────────────

const YEAR = /^\d{4}$/u;

const plTkYearOf = (now: Date): string => now.toISOString().slice(0, 4);

const sliceYear = (slice: string): number => {
  if (!YEAR.test(slice)) {
    return panic(`pl-tk slice is not a four-digit year: ${slice}`);
  }
  return Number(slice);
};

const plTkNextSlice = (slice: string): string | null => {
  const next = String(sliceYear(slice) + 1);
  return next > plTkYearOf(new Date()) ? null : next;
};

const plTkPreviousSlice = (slice: string): string | null => {
  const previous = String(sliceYear(slice) - 1);
  return previous < PL_TK_FIRST_YEAR ? null : previous;
};

/** The dates a listing page spans, newest first, from its dated rows. */
const pageSpan = (
  page: PlTkListingPage,
): { newest: string; oldest: string } | null => {
  const dates = page.rows.flatMap((row) =>
    row.decisionDate === undefined ? [] : [row.decisionDate],
  );
  const newest = dates.at(0);
  const oldest = dates.at(-1);
  return newest === undefined || oldest === undefined
    ? null
    : { newest, oldest };
};

/**
 * Every ruling of one stage dated in `year`.
 *
 * The listing is newest first, so the first page reaching back into the year
 * is found by bisection on each page's oldest date, and pages are read from
 * there until one ends before the year. Rows sharing a date can sit on either
 * side of a page break; reading whole pages and filtering by date keeps both.
 */
const listStageYear = async (
  stage: PlTkStage,
  year: string,
  signal: AbortSignal | undefined,
): Promise<Result<PlTkListingRow[], AdapterFetchError>> => {
  const label = `${year}:${stage}`;
  const listing = await openStageListing(stage, label, signal);
  if (Result.isError(listing)) {
    return listing;
  }
  const first = await readListingPage(listing.value, 0);
  if (Result.isError(first)) {
    return first;
  }
  const { totalPages } = first.value.page;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const spanOf = async (
    index: number,
  ): Promise<Result<{ newest: string; oldest: string }, AdapterFetchError>> => {
    const read = await readListingPage(listing.value, index);
    if (Result.isError(read)) {
      return read;
    }
    const span = pageSpan(read.value.page);
    return span === null
      ? Result.err(
          tkError(label, `the ${stage} listing page ${index} dates no row`),
        )
      : Result.ok(span);
  };

  // The first page whose oldest ruling is dated on or before the year's end.
  let low = 0;
  let high = totalPages;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const span = await spanOf(middle);
    if (Result.isError(span)) {
      return span;
    }
    if (span.value.oldest <= yearEnd) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  const rows: PlTkListingRow[] = [];
  for (let index = low; index < totalPages; index += 1) {
    const read = await readListingPage(listing.value, index);
    if (Result.isError(read)) {
      return read;
    }
    const { page } = read.value;
    rows.push(
      ...page.rows.filter(
        (row) =>
          row.decisionDate !== undefined &&
          row.decisionDate >= yearStart &&
          row.decisionDate <= yearEnd,
      ),
    );
    const span = pageSpan(page);
    if (span === null || span.oldest < yearStart) {
      break;
    }
  }
  return Result.ok(rows);
};

const listPlTkSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const stage = STAGE_ORDER[page];
  if (stage === undefined) {
    return { items: [], totalPages: STAGE_ORDER.length };
  }
  const listed = await listStageYear(stage, String(sliceYear(slice)), signal);
  if (Result.isError(listed)) {
    // The reconciliation engine holds the slice's previous ledger row on a
    // rejection, and would settle the slice over the outage on a page.
    return await Promise.reject(listed.error);
  }
  return {
    items: listed.value.map((row) => ({
      identity: plTkListingIdentity(row),
      payload: row,
    })),
    totalPages: STAGE_ORDER.length,
  };
};

const buildPlTkFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  const row = isRecord(payload) ? normalizePlTkListingRow(payload) : null;
  if (row === null) {
    return { type: "unkeyable" };
  }
  const label = row.decisionDate ?? row.documentId;
  const session = await openSession(label, signal);
  if (Result.isError(session)) {
    return await Promise.reject(session.error);
  }
  const attempted = await buildPlTkDecision({
    cursor: label,
    pageCache: new Map(),
    row,
    session: session.value,
    signal,
  });
  if (Result.isError(attempted)) {
    return await Promise.reject(attempted.error);
  }
  const built = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    case "detail-unavailable":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-tk build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Adapter ──────────────────────────────────────────────

export const plTkAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_TK,
  language: PL_TK_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // A page is a session, a search, up to two listing pages and a batch of
  // case pages, each behind the publisher gate and some slow to render.
  pageTimeoutMs: 300_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparsePlTkStoredRaw,

  sourceSurfaces: PL_TK_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_TK_SOURCE_FIELDS,
    listSourceFields: listPlTkSourceFields,
  },

  /** The three stages' listings together, counted from their pages. */
  async getTotalCount(signal) {
    let total = 0;
    for (const stage of STAGE_ORDER) {
      const counted = await Result.tryPromise({
        try: async () => await countStage(stage, signal),
        catch: errorTag,
      });
      if (Result.isError(counted)) {
        return { type: "probe-failed", errorTag: counted.error };
      }
      if (Result.isError(counted.value)) {
        return {
          type: "probe-failed",
          errorTag: errorTag(counted.value.error),
        };
      }
      total += counted.value.value.total;
    }
    return sourceTotalRead(total);
  },

  reconciliation: {
    firstSlice: PL_TK_FIRST_YEAR,
    sliceOf: plTkYearOf,
    nextSlice: plTkNextSlice,
    previousSlice: plTkPreviousSlice,
    tipWindowDays: PL_TK_TIP_WINDOW_SLICES,
    // A case page that held no text leaves a listing-only row; unset, that
    // row would count as held and its text would never be fetched again.
    heldRequiresDetail: true,
    listSlicePage: listPlTkSlicePage,
    buildDecision: buildPlTkFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plTkFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_TK, cursor),
      }),
    );
  },
});
