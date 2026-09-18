/**
 * Hungarian courts (Bírósági Határozatok Gyűjteménye) adapter.
 *
 * The Országos Bírósági Hivatal publishes every Hungarian court's anonymised
 * decisions at eakta.birosag.hu behind one search endpoint. `hu-bhgy.research.md`
 * beside this file states the endpoint, the facets and the row shape; three of
 * its measurements decide everything below.
 *
 * **The count saturates at 10 000 and the offset refuses to pass it.** Any
 * query matching more than that answers `Count: 10000`, and
 * `ResultStartIndex: 10000` answers `Success: false`. So every walk has to run
 * inside a window the publisher can serve whole. The only filter the row's own
 * axis offers is the decision year (`MeghozatalIdejeTol`/`Ig` take a year, not
 * a date), and a whole year saturates for most of the collection's range.
 * Year × kollégium does not.
 *
 * **The five kollégium filters cover a year.** Their union is the unfiltered
 * year. A decision filed under two colleges is listed under both —
 * `Kollegium` reads `polgári; gazdasági` — so the windows
 * overlap and their counts sum above the year's own. Overlap costs a duplicate
 * observation; a gap would cost a decision, and there is none.
 *
 * **`IndexelesIdeje` only ever appends.** Sorted `IndexelesIdejeNovekvo` a
 * window grows at its end, so an offset the crawl has already passed cannot
 * shift under it (rule 19's fixed-set half). The publisher's clock runs ahead
 * of ours — the newest row can carry tomorrow's timestamp — so the frontier is
 * read off the rows and never off a local clock.
 *
 * Cursor, therefore, in two phases:
 *
 *   sweep|<boundary>|<year>|<kollégium>|<offset>
 *   tip|<frontier>|<offset>
 *
 * The sweep pages each year × kollégium window oldest-first in publication
 * order. `<boundary>` is the newest publication timestamp at the moment the
 * sweep started, taken once in one request and carried unchanged: everything
 * published while the sweep runs is behind it, and the tip picks it up from
 * exactly there rather than from a rolling lookback (rule 19).
 *
 * The tip is a frontier, not a window. It reads the collection newest-first and
 * stops at the first row at or below `<frontier>`, so a cycle with nothing new
 * costs one request and returns the cursor it was given. `<offset>` is only
 * non-zero while a catch-up is still walking back toward the frontier.
 *
 * What the tip cannot do is find a decision published into a year the sweep has
 * already passed — the publisher back-fills old years constantly. That is the
 * reconciliation ledger's, and its slices are the same year × kollégium windows
 * (rule 16).
 */

import { Result, panic } from "better-result";

import type { Document as FolioDocument } from "@stll/docx-core/model";
import { parseDocx } from "@stll/folio-core/server";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";
import { Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  storedSourceSurface,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  sourceTotalRead,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  STORED_RAW_REPARSE_REJECTION,
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
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  huBhgyHeaderLabelsOf,
  parseHuBhgyDecision,
} from "@/api/handlers/case-law/ingestion/parsers/hu-bhgy";
import type { HuBhgyHeaderLabel } from "@/api/handlers/case-law/ingestion/parsers/hu-bhgy";
import { arrayOrEmpty } from "@/api/lib/array";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
  presentTextField,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { readRtf, isRtf } from "@/api/lib/legal-search/parsers/rtf-reader";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const SEARCH_URL = "https://eakta.birosag.hu/AnonimizaltHatarozat/Search?Area=";
const DOCUMENT_PATH = "https://eakta.birosag.hu/hatarozat-letoltes/";
const DECISION_PAGE = "https://eakta.birosag.hu/anonimizalt-hatarozatok";

/**
 * The only origin this adapter may reach. Every URL it fetches is built here
 * from opaque publisher fields, and this is what keeps it that way if a payload
 * ever supplies one (rule 21).
 */
const HU_BHGY_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://eakta.birosag.hu"],
} as const;

const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(
  ADAPTER_KEYS.HU_BHGY,
);

const HU_BHGY_LANGUAGE = "hu";

const HU_BHGY_DATE_RANGE = ADAPTER_MANIFESTS[ADAPTER_KEYS.HU_BHGY].dateRange;

/** The oldest decision year the search form offers. */
const FIRST_YEAR = Number(HU_BHGY_DATE_RANGE.fromInclusive.slice(0, 4));

/** The search's own page-size ceiling; a larger request answers this many. */
const MAX_PAGE_SIZE = 100;

/**
 * The value `Count` reports for any query matching at least this many rows, and
 * the offset the search refuses to pass. A window reporting it cannot be walked
 * to its end, so it is a failure rather than a large window.
 */
const SATURATION_COUNT = 10_000;

/**
 * Rows the crawl lists at a time.
 *
 * Every listed row costs a document request behind the same gate, so a page is
 * one listing request plus this many downloads.
 */
const CRAWL_PAGE_SIZE = 20;

/**
 * Pages the tip may walk back in one cycle.
 *
 * The catch-up is bounded by the offset ceiling either way; this keeps one
 * cycle's cost in proportion to a cycle, and what a cycle does not reach stays
 * ahead of the frontier it banks.
 */
const MAX_TIP_PAGES = 5;

/**
 * Consecutive empty windows one `fetchPage` may step over before it banks the
 * progress it made. 1990 to 1995 are empty, and so is every college a small
 * year never used, so a cold start would otherwise spend one cycle per window.
 */
const MAX_EMPTY_WINDOW_SKIPS = 12;

/**
 * The five colleges, in the order the slices sort.
 *
 * A slice is `<year>-<slug>` and the ledger relies on slices sorting in walk
 * order, so the slug is ASCII and the order is its own: the accented Hungarian
 * names would sort by code point, not by the list.
 */
const KOLLEGIUMOK = [
  { slug: "a-buntet", value: "büntető" },
  { slug: "b-gazd", value: "gazdasági" },
  { slug: "c-kozig", value: "közigazgatási" },
  { slug: "d-munka", value: "munkaügyi" },
  { slug: "e-polg", value: "polgári" },
] as const;

type KollegiumSlug = (typeof KOLLEGIUMOK)[number]["slug"];

const KOLLEGIUM_BY_SLUG = new Map<string, string>(
  KOLLEGIUMOK.map(({ slug, value }) => [slug, value]),
);

const FIRST_SLUG = KOLLEGIUMOK[0].slug;
const LAST_SLUG = KOLLEGIUMOK.at(-1)?.slug ?? FIRST_SLUG;

const SORT = {
  PUBLISHED_ASC: "IndexelesIdejeNovekvo",
  PUBLISHED_DESC: "IndexelesIdejeCsokkeno",
} as const;

// ── Publisher payloads ───────────────────────────────────

type HuBhgyRelated = {
  KapcsolodoUgyszam?: string | undefined;
  KapcsolodoBirosag?: string | undefined;
};

/** One decision as the search lists it. Every field the row can state. */
export type HuBhgyRow = {
  Azonosito?: string | undefined;
  MeghozoBirosag?: string | undefined;
  Kollegium?: string | undefined;
  JogTerulet?: string | undefined;
  KapcsolodoHatarozatok?: HuBhgyRelated[] | undefined;
  Jogszabalyhelyek?: string | undefined;
  HatarozatEve?: number | undefined;
  Szoveg?: string | undefined;
  Rezume?: string | undefined;
  RezumeSzovegKornyezet?: string | undefined;
  EgyediAzonosito?: string | undefined;
  IndexelesIdeje?: string | undefined;
  NemHivatkozhatoSzoveg?: string | undefined;
  IndexId?: string | undefined;
  DownloadLink?: string | undefined;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const optionalRelated = (value: unknown): HuBhgyRelated[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  return value.filter(isRecord).map((item) => ({
    KapcsolodoUgyszam: optionalString(item["KapcsolodoUgyszam"]),
    KapcsolodoBirosag: optionalString(item["KapcsolodoBirosag"]),
  }));
};

/**
 * Read a listing row leniently: the search adds fields without notice and all
 * of them land in JSONB, so only the shape of what is read here is checked.
 */
export const normalizeHuBhgyRow = (
  value: Record<string, unknown>,
): HuBhgyRow => ({
  Azonosito: optionalString(value["Azonosito"]),
  MeghozoBirosag: optionalString(value["MeghozoBirosag"]),
  Kollegium: optionalString(value["Kollegium"]),
  JogTerulet: optionalString(value["JogTerulet"]),
  KapcsolodoHatarozatok: optionalRelated(value["KapcsolodoHatarozatok"]),
  Jogszabalyhelyek: optionalString(value["Jogszabalyhelyek"]),
  HatarozatEve: optionalNumber(value["HatarozatEve"]),
  Szoveg: optionalString(value["Szoveg"]),
  Rezume: optionalString(value["Rezume"]),
  RezumeSzovegKornyezet: optionalString(value["RezumeSzovegKornyezet"]),
  EgyediAzonosito: optionalString(value["EgyediAzonosito"]),
  IndexelesIdeje: optionalString(value["IndexelesIdeje"]),
  NemHivatkozhatoSzoveg: optionalString(value["NemHivatkozhatoSzoveg"]),
  IndexId: optionalString(value["IndexId"]),
  DownloadLink: optionalString(value["DownloadLink"]),
});

/**
 * The search's envelope, read strictly.
 *
 * `Success: false` is a refusal carrying a Hungarian message, not an empty
 * result, and an unreadable body is neither (rule 20): both come back as
 * `null` and the caller reports them as the slice's failure.
 */
export type HuBhgySearchResult = {
  rows: Record<string, unknown>[];
  count: number;
};

export const readHuBhgySearch = (value: unknown): HuBhgySearchResult | null => {
  if (!isRecord(value) || value["Success"] !== true) {
    return null;
  }
  const count = value["Count"];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return null;
  }
  const list = value["List"];
  if (list === null) {
    return { rows: [], count };
  }
  if (!Array.isArray(list)) {
    return null;
  }
  return { rows: list.filter(isRecord), count };
};

// ── Requests ─────────────────────────────────────────────

const searchError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `eakta.birosag.hu: ${message}`,
    adapterKey: ADAPTER_KEYS.HU_BHGY,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

export type HuBhgyQuery = {
  /** A decision year, or `undefined` for the whole collection. */
  year?: number | undefined;
  kollegium?: string | undefined;
  sort: (typeof SORT)[keyof typeof SORT];
  offset: number;
  pageSize: number;
};

export const huBhgySearchBody = ({
  kollegium,
  offset,
  pageSize,
  sort,
  year,
}: HuBhgyQuery): string =>
  new URLSearchParams({
    Rendezes: sort,
    ResultCount: String(pageSize),
    ResultStartIndex: String(offset),
    // Everything the collection holds: the citable-only default would leave the
    // rows the publisher marks `NemHivatkozhato` out of the corpus, and the row
    // states that marking itself.
    NemHivatkozhato: "igen",
    ...(year === undefined
      ? {}
      : { MeghozatalIdejeTol: String(year), MeghozatalIdejeIg: String(year) }),
    ...(kollegium === undefined ? {} : { Kollegium: kollegium }),
  }).toString();

type SearchOptions = {
  cursor: string;
  query: HuBhgyQuery;
  signal?: AbortSignal | undefined;
};

type SearchResponse = HuBhgySearchResult & {
  /** The response body verbatim, for the stored raw envelope. */
  raw: string;
  /** The request that answered, for a recorded fixture's provenance. */
  url: string;
};

const search = async ({
  cursor,
  query,
  signal,
}: SearchOptions): Promise<Result<SearchResponse, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: HU_BHGY_HOST_POLICY,
    rawUrl: SEARCH_URL,
  });
  if (target === null) {
    return panic("eakta.birosag.hu search escaped the publisher origin");
  }

  const response = await fetchWithRetry(
    target.toString(),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: huBhgySearchBody(query),
      redirect: "error",
    },
    {
      adapterKey: ADAPTER_KEYS.HU_BHGY,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.LIST,
    },
  );
  if (!response.ok) {
    return Result.err(
      searchError(
        cursor,
        `search answered ${response.status}`,
        response.status,
      ),
    );
  }

  const raw = await response.text();
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  const read = readHuBhgySearch(parsed);
  if (read === null) {
    return Result.err(
      searchError(
        cursor,
        `search answered no readable result: ${raw.slice(0, 200)}`,
      ),
    );
  }
  return Result.ok({ ...read, raw, url: target.toString() });
};

/** The publisher's own page for a decision, which is what a reader is sent to. */
const decisionUrl = (row: HuBhgyRow): string =>
  `${DECISION_PAGE}?${new URLSearchParams({
    azonosito: row.Azonosito ?? "",
    birosag: row.MeghozoBirosag ?? "",
  }).toString()}`;

/**
 * The download the decision's own bytes come from, rebuilt from the row's three
 * opaque fields rather than from anything the payload links to (rule 21).
 */
const documentUrlOf = (row: HuBhgyRow): string =>
  `${DOCUMENT_PATH}?${new URLSearchParams({
    birosagName: row.MeghozoBirosag ?? "",
    ugyszam: row.Azonosito ?? "",
    azonosito: row.IndexId ?? "",
  }).toString()}`;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RTF_CONTENT_TYPE = "application/rtf";

/** What the publisher served for a decision, and which reader reads it. */
type DecisionDocument = {
  bytes: Uint8Array;
  contentType: typeof DOCX_CONTENT_TYPE | typeof RTF_CONTENT_TYPE;
};

const DOCX_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/**
 * Classify the served bytes by what they are, not by what the header says.
 *
 * The collection's legacy half is served under filenames ending `.docx` that
 * hold RTF, so the `Content-Type` and the `Content-Disposition` disagree with
 * each other on the same response. The signature does not.
 */
export const huBhgyDocumentOf = (
  bytes: Uint8Array,
): DecisionDocument | undefined => {
  if (isRtf(bytes)) {
    return { bytes, contentType: RTF_CONTENT_TYPE };
  }
  if (DOCX_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return { bytes, contentType: DOCX_CONTENT_TYPE };
  }
  return undefined;
};

const fetchDocument = async (
  row: HuBhgyRow,
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<DecisionDocument | undefined, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: HU_BHGY_HOST_POLICY,
    rawUrl: documentUrlOf(row),
  });
  if (target === null) {
    return panic("eakta.birosag.hu download escaped the publisher origin");
  }
  const response = await fetchWithRetry(
    target.toString(),
    { redirect: "error" },
    {
      adapterKey: ADAPTER_KEYS.HU_BHGY,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.PAGE,
    },
  );
  if (response.status === 404 || response.status === 410) {
    // The listing states the decision exists and the download does not serve
    // it: a durable listing-only observation, not a page failure (rule 20).
    return Result.ok(undefined);
  }
  if (!response.ok) {
    return Result.err(
      searchError(
        cursor,
        `download answered ${response.status}`,
        response.status,
      ),
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return Result.ok(huBhgyDocumentOf(bytes));
};

// ── Normalization ────────────────────────────────────────

/**
 * The provisions the publisher tagged, split out of the `</br>`-joined string
 * and parsed into the parts a citation is built from.
 *
 * `2013. évi V. törvény a Polgári Törvénykönyvről 3:17. § (6) - 2025-10-01`
 * and `15/1990. BM rendelet 4. §`.
 */
export type HuStatuteReference = {
  act: {
    year?: number | undefined;
    number?: string | undefined;
    kind?: string | undefined;
    title?: string | undefined;
  };
  section?: string | undefined;
  subsection?: string | undefined;
  /** The version date the publisher tagged the provision as of. */
  asOf?: string | undefined;
  /** The entry verbatim, so nothing the parse below misses is lost. */
  raw: string;
};

// The title runs to the end of the line and is trimmed in code. Written as a
// greedy `.*` rather than as `\s*(.*?)\s*$`: `.` and `\s` overlap, so the
// lazy-plus-trailing-whitespace spelling backtracks super-linearly on a long
// line, and a court's own line is exactly the input nobody bounds.
const ACT_HEAD =
  /^(?<year>\d{4})\.\s*évi\s+(?<number>[IVXLCDM]+)\.\s*(?<kind>törvényerejű rendelet|törvény)(?<title>.*)$/u;
// `BM rendelet`, `IM rendelet`, `(II. 1.) NGM határozat`: at most three
// whitespace-separated qualifiers before the noun. Bounded and split on
// whitespace the qualifier class excludes, where `[^\d]*?rendelet` let the
// class and the literal it precedes match the same characters.
const DECREE_HEAD =
  /^(?<number>\d{1,4}\/\d{4})\.?\s*(?:\([^)]*\)\s*)?(?<kind>(?:[^\d\s]{1,24}\s){0,3}(?:rendelet|határozat))(?<title>.*)$/u;
const SECTION_TAIL =
  /\s(?<section>\d+(?::\d+)?(?:\/[A-ZÁÉÍÓÖŐÚÜŰ])?)\.\s*§(?:\s*\((?<subsection>[^)]+)\))?\s*$/u;
const AS_OF = /\s-\s(?<date>\d{4}-\d{2}-\d{2})\s*$/u;

/**
 * One entry, with the separator's own trailing semicolon dropped. A scan
 * rather than `/;\s*$/`, which re-reads the tail from every start position.
 */
const withoutTrailingSemicolon = (entry: string): string => {
  const trimmed = entry.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed;
};

/** One `</br>`-separated entry, read into its parts. */
const huStatuteReferenceOf = (entry: string): HuStatuteReference => {
  const asOf = AS_OF.exec(entry)?.groups?.["date"];
  const withoutDate =
    asOf === undefined ? entry : entry.replace(AS_OF, "").trim();
  const tail = SECTION_TAIL.exec(withoutDate)?.groups;
  const head =
    tail === undefined
      ? withoutDate
      : withoutDate.replace(SECTION_TAIL, "").trim();
  const act = ACT_HEAD.exec(head)?.groups ?? DECREE_HEAD.exec(head)?.groups;
  const year = act?.["year"];
  const number = act?.["number"];
  const kind = act?.["kind"]?.trim();
  const title = act?.["title"]?.trim();
  const section = tail?.["section"];
  const subsection = tail?.["subsection"];

  // Assigned rather than spread from conditionals: an absent part stays
  // absent, and the entry it was read from is kept whatever the patterns above
  // did or did not recognise.
  const reference: HuStatuteReference = { act: {}, raw: entry };
  if (year !== undefined) {
    reference.act.year = Number(year);
  }
  if (number !== undefined) {
    reference.act.number = number;
  }
  if (kind !== undefined && kind.length > 0) {
    reference.act.kind = kind;
  }
  if (title !== undefined && title.length > 0) {
    reference.act.title = title;
  }
  if (section !== undefined) {
    reference.section = section;
  }
  if (subsection !== undefined) {
    reference.subsection = subsection;
  }
  if (asOf !== undefined) {
    reference.asOf = asOf;
  }
  return reference;
};

export const parseHuStatuteReferences = (
  value: string | undefined,
): HuStatuteReference[] =>
  value === undefined
    ? []
    : value
        .split(/<\/?br\s*\/?>/iu)
        .map(withoutTrailingSemicolon)
        .filter((entry) => entry.length > 0)
        .map(huStatuteReferenceOf);

/** The colleges a row states; the publisher joins several with `"; "`. */
export const huKollegiumsOf = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

/**
 * The identity a listed row is stored under.
 *
 * `IndexId` is the publisher's own key for the document — the GUID a current
 * decision carries, the migration key a legacy one does — and it is what the
 * download is addressed by. `Azonosito` alone is not an identity: the same
 * docket recurs at two courts, and the collection covers every court of the
 * country (rule 17).
 */
export const huBhgyListingIdentity = (row: HuBhgyRow): ListingIdentity => {
  const { IndexId } = row;
  if (IndexId !== undefined && isPersistableSourceDocumentId(IndexId)) {
    return { type: "document", sourceDocumentId: IndexId };
  }
  const caseNumber = row.Azonosito;
  return caseNumber === undefined
    ? { type: "unidentifiable" }
    : { type: "case-number", caseNumber, language: HU_BHGY_LANGUAGE };
};

/**
 * The exact publisher keys a row exposes beside `IndexId`.
 *
 * `EgyediAzonosito` is the BHGY identifier per 29/2007. (V. 31.) IRM rendelet
 * and names the same document; emitted as an alias so an observation keyed
 * either way converges on one row (rule 20).
 */
const aliasesOf = (row: HuBhgyRow): string[] => {
  const alias = row.EgyediAzonosito;
  return alias !== undefined && isPersistableSourceDocumentId(alias)
    ? [alias]
    : [];
};

// ── Build ────────────────────────────────────────────────

/**
 * The parts of the stored raw envelope, named by the response each holds.
 * A replay reads exactly what a crawl kept, so the names are the contract.
 */
const RAW_PART = {
  LISTING: "listing",
  DOCUMENT: "document",
  DOCUMENT_CONTENT_TYPE: "documentContentType",
} as const;

/**
 * The docket the listing states and the one the document prints, which are two
 * spellings of one number: `Gfv.30091/2025/4` drops the thousands dot and the
 * panel numeral that `Gfv.VI.30.091/2025/4.` keeps. Both are exact, so a
 * citation of either has to reach this decision.
 */
const decisionIdentifiers = (
  listed: string,
  printed: string | undefined,
): DecisionIdentifiers =>
  printed === undefined || printed === listed
    ? [{ type: "case-number", value: listed }]
    : [
        { type: "case-number", value: listed },
        { type: "case-number", value: printed },
      ];

/**
 * The decision file in folio's document model, whichever era served it.
 *
 * One dispatch, because the field inventory reads the same stored bytes the
 * parse does: two readers would let the labels an inventory declares and the
 * labels a parse reads come from different documents.
 */
const readHuBhgyDocument = async (
  document: DecisionDocument,
): Promise<FolioDocument> =>
  document.contentType === RTF_CONTENT_TYPE
    ? readRtf(document.bytes)
    : await parseDocx(document.bytes, {
        detectVariables: false,
        preloadFonts: false,
      });

type HuBhgyBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No publisher key and no docket; nothing can store this row. */
  | { type: "unkeyable" }
  /** The download served nothing this adapter recognises as a document. */
  | { type: "detail-unavailable"; decision: IngestionResult };

export type AssembleHuBhgyOptions = {
  row: HuBhgyRow;
  document: DecisionDocument | undefined;
  rawParts: SourceRawParts;
};

/**
 * Build one decision from the responses already in hand.
 *
 * No I/O: the crawl, the reconciliation walk and a replay of the stored
 * envelope all reach this with the same two payloads, so none of them can key,
 * parse or enrich a row differently from the others.
 */
export const assembleHuBhgyDecision = async ({
  document,
  rawParts,
  row,
}: AssembleHuBhgyOptions): Promise<HuBhgyBuildResult> => {
  const { IndexId } = row;
  const caseNumber = row.Azonosito;
  if (
    IndexId === undefined ||
    !isPersistableSourceDocumentId(IndexId) ||
    caseNumber === undefined
  ) {
    return { type: "unkeyable" };
  }
  // The deciding court is the row's own field, never a constant: this source
  // publishes for every court of the country.
  const court = row.MeghozoBirosag ?? "";
  if (court.length === 0) {
    logger.warn("case_law.ingestion.court_not_stated", {
      adapterKey: ADAPTER_KEYS.HU_BHGY,
      caseNumber,
    });
  }

  const statutes = parseHuStatuteReferences(row.Jogszabalyhelyek);
  const parsed =
    document === undefined
      ? null
      : await Result.tryPromise({
          try: async () =>
            parseHuBhgyDecision({
              document: await readHuBhgyDocument(document),
              listedCaseNumber: caseNumber,
              court,
              sourceUrl: decisionUrl(row),
              documentUrl: documentUrlOf(row),
              documentId: IndexId,
              statutes: statutes.map(({ raw }) => raw),
            }),
          catch: errorTag,
        });
  if (parsed !== null && Result.isError(parsed)) {
    logger.warn("case_law.ingestion.document_parse_failed", {
      adapterKey: ADAPTER_KEYS.HU_BHGY,
      caseNumber,
      "error.type": parsed.error,
    });
  }
  const read = parsed !== null && Result.isOk(parsed) ? parsed.value : null;
  if (read !== null && read.readerWarnings.length > 0) {
    logger.warn("case_law.ingestion.ast_structure_degraded", {
      parser: ADAPTER_KEYS.HU_BHGY,
      caseNumber,
      language: HU_BHGY_LANGUAGE,
      url: decisionUrl(row),
      codes: "READER_UNHANDLED_MARKUP",
      issues: read.readerWarnings.join("; "),
      blockCount: read.documentAst.blocks.length,
    });
  }
  const documentAst: DocumentAst | EmptyAst = read?.documentAst ?? EMPTY_AST;

  const related = arrayOrEmpty(row.KapcsolodoHatarozatok).flatMap(
    ({ KapcsolodoBirosag, KapcsolodoUgyszam }) =>
      KapcsolodoUgyszam === undefined
        ? []
        : [
            {
              caseNumber: KapcsolodoUgyszam,
              ...(KapcsolodoBirosag === undefined
                ? {}
                : { court: KapcsolodoBirosag }),
            },
          ],
  );

  const sourceRaw = encodeSourceRawEnvelope(rawParts);
  const decision: IngestionResult = {
    caseNumber,
    // The listed docket and the one the document prints are two spellings of
    // one number: `Gfv.30091/2025/4` drops the thousands dot and the panel
    // numeral the document keeps. Both are exact, so both are stated.
    identifiers: decisionIdentifiers(caseNumber, read?.documentDocket),
    sourceDocumentId: IndexId,
    ...(aliasesOf(row).length === 0
      ? {}
      : { sourceDocumentIdAliases: aliasesOf(row) }),
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.HU_BHGY].country,
    language: HU_BHGY_LANGUAGE,
    ...(read?.decisionDate === undefined
      ? {}
      : { decisionDate: read.decisionDate }),
    ...(read?.decisionType === undefined
      ? {}
      : { decisionType: read.decisionType }),
    ...(read?.fulltext === undefined ? {} : { fulltext: read.fulltext }),
    ...(read?.sections === undefined ? {} : { sections: read.sections }),
    ...(document === undefined ? { isListingOnly: true } : {}),
    sourceUrl: decisionUrl(row),
    documentUrl: documentUrlOf(row),
    // `Rezume` is the publisher's own summary of the decision, printed beside
    // it in the listing; the collection prints no abstract or legal sentence.
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      ...(row.Rezume === undefined
        ? {}
        : { headnote: presentTextField(row.Rezume) }),
    },
    ...(read === null || read.judges.length === 0
      ? {}
      : { judges: read.judges }),
    publisherCitedCases: related.map(({ caseNumber: number }) => number),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court,
      ...(read?.decisionDate === undefined
        ? {}
        : { decisionDate: read.decisionDate }),
      ...(read?.decisionType === undefined
        ? {}
        : { decisionType: read.decisionType }),
      documentId: IndexId,
      bhgyIdentifier: row.EgyediAzonosito,
      kollegiums: huKollegiumsOf(row.Kollegium),
      legalArea: row.JogTerulet,
      decisionYear: row.HatarozatEve,
      publishedAt: row.IndexelesIdeje,
      statutes,
      relatedProceedings: related,
      ...(read?.documentDocket === undefined
        ? {}
        : { documentDocket: read.documentDocket }),
      ...(document === undefined
        ? {}
        : { documentContentType: document.contentType }),
      ...(read?.relatedProceedings === undefined ||
      read.relatedProceedings.length === 0
        ? {}
        : { instanceChainLines: read.relatedProceedings }),
      ...(document === undefined
        ? {
            detailUnavailable:
              "the download served nothing this adapter reads as a document",
          }
        : {}),
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.HU_BHGY],
    documentAst,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };

  return document === undefined
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

/** The envelope a crawl writes, so nothing else has to spell its part names. */
export const huBhgyRawPartsOf = (
  row: Record<string, unknown>,
  document: DecisionDocument | undefined,
): SourceRawParts => ({
  [RAW_PART.LISTING]: JSON.stringify(row),
  ...(document === undefined
    ? {}
    : {
        [RAW_PART.DOCUMENT]: Buffer.from(document.bytes).toString("base64"),
        [RAW_PART.DOCUMENT_CONTENT_TYPE]: document.contentType,
      }),
});

type BuildOptions = {
  cursor: string;
  row: Record<string, unknown>;
  signal?: AbortSignal | undefined;
};

/**
 * Fetch a listed row's document, then assemble it.
 *
 * A refused request is the row's failure rather than its absence: the publisher
 * was asked and did not answer, so the caller holds its cursor and asks again
 * instead of storing a row that says the document does not exist.
 */
const buildHuBhgyDecision = async ({
  cursor,
  row,
  signal,
}: BuildOptions): Promise<Result<HuBhgyBuildResult, AdapterFetchError>> => {
  const normalized = normalizeHuBhgyRow(row);
  if (
    normalized.IndexId === undefined ||
    !isPersistableSourceDocumentId(normalized.IndexId)
  ) {
    return Result.ok({ type: "unkeyable" });
  }
  const fetched = await fetchDocument(normalized, cursor, signal);
  if (Result.isError(fetched)) {
    return fetched;
  }
  const document = fetched.value;
  return Result.ok(
    await assembleHuBhgyDecision({
      row: normalized,
      document,
      rawParts: huBhgyRawPartsOf(row, document),
    }),
  );
};

/**
 * Re-parse a stored envelope into the decision this adapter would build from it
 * today, without contacting the publisher.
 */
const reparseHuBhgyStoredRaw = async (
  stored: StoredRawReparseInput,
): Promise<StoredRawReparseOutcome> => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: (listing) => normalizeHuBhgyRow(listing).IndexId,
  });
  if (read.type === "rejected") {
    return read;
  }
  const { listing, parts } = read;
  const row = normalizeHuBhgyRow(listing);

  const documentPart = parts[RAW_PART.DOCUMENT];
  const document =
    documentPart === undefined
      ? undefined
      : huBhgyDocumentOf(new Uint8Array(Buffer.from(documentPart, "base64")));
  const built = await assembleHuBhgyDecision({
    row,
    document,
    rawParts: parts,
  });
  return built.type === "unkeyable"
    ? {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: "the stored listing row states no publisher id or docket",
      }
    : { type: "parsed", result: built.decision };
};

// ── Source-field inventory ───────────────────────────────

/** Every field the search labels on one decision's listing row. */
const LISTING_FIELDS = [
  "Azonosito",
  "MeghozoBirosag",
  "Kollegium",
  "JogTerulet",
  "KapcsolodoHatarozatok",
  "Jogszabalyhelyek",
  "HatarozatEve",
  "Szoveg",
  "Rezume",
  "RezumeSzovegKornyezet",
  "EgyediAzonosito",
  "IndexelesIdeje",
  "NemHivatkozhatoSzoveg",
  "IndexId",
  "DownloadLink",
] as const;

/**
 * The labels the decision file prints down its header, which state what no
 * listing row does: the panel, the parties, their counsel, the subject of the
 * suit and the courts below.
 *
 * Read from the parser's own list, so a label it learns to read is a label
 * this inventory has to decide about.
 */
const DOCUMENT_FIELDS = [
  "Az ügy száma",
  "A tanács tagjai",
  "A felperes",
  "A felperes képviselője",
  "Az alperes",
  "Az alperes képviselője",
  "A per tárgya",
  "A felülvizsgálati kérelmet benyújtó fél",
  "A másodfokú bíróság neve",
  "Az elsőfokú bíróság neve",
] as const satisfies readonly HuBhgyHeaderLabel[];

const SOURCE_FIELDS = [...LISTING_FIELDS, ...DOCUMENT_FIELDS] as const;

const HU_BHGY_SOURCE_FIELDS = {
  Azonosito: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  MeghozoBirosag: {
    disposition: "stored",
    target: { type: "result", key: "court" },
  },
  Kollegium: {
    disposition: "stored",
    target: { type: "metadata", key: "kollegiums" },
  },
  JogTerulet: {
    disposition: "stored",
    target: { type: "metadata", key: "legalArea" },
  },
  KapcsolodoHatarozatok: {
    disposition: "stored",
    target: { type: "metadata", key: "relatedProceedings" },
  },
  Jogszabalyhelyek: {
    disposition: "stored",
    target: { type: "metadata", key: "statutes" },
  },
  HatarozatEve: {
    disposition: "stored",
    target: { type: "metadata", key: "decisionYear" },
  },
  // The search never fills this on a listing row; the decision's text comes
  // from the download, which is what `documentAst` and `fulltext` are read
  // from.
  Szoveg: excludedSourceField(
    "always null on a listing row; the decision's text is the downloaded document",
  ),
  Rezume: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  // Only a keyword search fills this: it is the résumé re-rendered with the
  // query's hits marked, so it is a view of `Rezume` rather than a field.
  RezumeSzovegKornyezet: excludedSourceField(
    "keyword-search highlight over Rezume, which is stored whole",
  ),
  EgyediAzonosito: {
    disposition: "stored",
    target: { type: "metadata", key: "bhgyIdentifier" },
  },
  IndexelesIdeje: {
    disposition: "stored",
    target: { type: "metadata", key: "publishedAt" },
  },
  // The verbatim row is kept in the envelope, so reading this later is a
  // parser change rather than another walk of the collection.
  NemHivatkozhatoSzoveg: excludedSourceField(
    "null on every row the search serves; the citability filter changes no count it reports",
  ),
  IndexId: { disposition: "stored", target: { type: "identity" } },
  // Always null: the collection addresses a download by the three fields above
  // rather than by a link, and a link in a payload is not one this adapter
  // would follow (rule 21).
  DownloadLink: excludedSourceField(
    "always null; the download URL is rebuilt from IndexId, Azonosito and MeghozoBirosag",
  ),

  // ── The decision file's header ──

  // `Gfv.VI.30.197/2024/4.` against the row's `Gfv.30197/2024/4`: the same
  // number with the thousands dot and the panel numeral the listing drops.
  "Az ügy száma": {
    disposition: "stored",
    target: { type: "metadata", key: "documentDocket" },
  },
  "A tanács tagjai": {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  "A felperes": { disposition: "stored", target: { type: "document" } },
  "A felperes képviselője": {
    disposition: "stored",
    target: { type: "document" },
  },
  "Az alperes": { disposition: "stored", target: { type: "document" } },
  "Az alperes képviselője": {
    disposition: "stored",
    target: { type: "document" },
  },
  "A per tárgya": { disposition: "stored", target: { type: "document" } },
  "A felülvizsgálati kérelmet benyújtó fél": {
    disposition: "stored",
    target: { type: "document" },
  },
  "A másodfokú bíróság neve": {
    disposition: "stored",
    target: { type: "metadata", key: "instanceChainLines" },
  },
  "Az elsőfokú bíróság neve": {
    disposition: "stored",
    target: { type: "metadata", key: "instanceChainLines" },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

/** The row's own keys, as the search served them. */
const listingFieldsIn = (payload: string | undefined): readonly string[] => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(payload ?? ""),
    catch: () => null,
  }).unwrapOr(null);
  return isRecord(parsed) ? Object.keys(parsed) : [];
};

/**
 * What the publisher states across the whole stored envelope: the listing
 * row's keys and the labels the decision file prints in its header.
 *
 * The file is read, not scanned: a label only counts where the reader that
 * builds the decision sees it, so a document this adapter cannot read states
 * no header label rather than a guessed one.
 */
const listHuBhgySourceFields = async (
  parts: SourceRawParts,
): Promise<readonly string[]> => {
  const listing = listingFieldsIn(parts[RAW_PART.LISTING]);
  const documentPart = parts[RAW_PART.DOCUMENT];
  if (documentPart === undefined) {
    return listing;
  }
  const document = huBhgyDocumentOf(
    new Uint8Array(Buffer.from(documentPart, "base64")),
  );
  if (document === undefined) {
    return listing;
  }
  const read = await Result.tryPromise({
    try: async () => await readHuBhgyDocument(document),
    catch: errorTag,
  });
  return Result.isError(read)
    ? listing
    : [...listing, ...huBhgyHeaderLabelsOf(read.value)];
};

/**
 * The publisher's pages for one decision.
 *
 * Two are recorded. The other two restate them: the PDF endpoint renders the
 * same file this adapter stores the bytes of, and the deep link is the
 * collection's own search page addressed by two fields of the row.
 */
const SOURCE_SURFACES = [
  "listing",
  "document",
  "pdf-rendition",
  "decision-page",
] as const;

const HU_BHGY_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    document: storedSourceSurface(RAW_PART.DOCUMENT),
    "pdf-rendition": excludedSourceSurface(
      "the stored file rendered for print; it states the same text and no label the file does not",
    ),
    "decision-page": excludedSourceSurface(
      "the collection's search page addressed by the row's Azonosito and MeghozoBirosag; it states the listing row that addresses it",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Slices ───────────────────────────────────────────────

const currentYear = (): number => Temporal.Now.plainDateISO("UTC").year;

/** `2012-e-polg`: the decision year and the college, sorting in walk order. */
export const huBhgySlice = (year: number, slug: KollegiumSlug): string =>
  `${year}-${slug}`;

const SLICE_PATTERN = /^(?<year>\d{4})-(?<slug>[a-z-]+)$/u;

export const parseHuBhgySlice = (
  slice: string,
): { year: number; kollegium: string } | null => {
  const groups = SLICE_PATTERN.exec(slice)?.groups;
  const year = groups?.["year"];
  const slug = groups?.["slug"];
  if (year === undefined || slug === undefined) {
    return null;
  }
  const kollegium = KOLLEGIUM_BY_SLUG.get(slug);
  return kollegium === undefined ? null : { year: Number(year), kollegium };
};

const slugIndex = (slug: string): number =>
  KOLLEGIUMOK.findIndex((entry) => entry.slug === slug);

const HU_BHGY_FIRST_SLICE = huBhgySlice(FIRST_YEAR, FIRST_SLUG);

const sliceOf = (now: Date): string =>
  huBhgySlice(
    Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
      "UTC",
    ).year,
    LAST_SLUG,
  );

const nextSlice = (slice: string): string | null => {
  const groups = SLICE_PATTERN.exec(slice)?.groups;
  const year = Number(groups?.["year"] ?? Number.NaN);
  const index = slugIndex(groups?.["slug"] ?? "");
  if (!Number.isInteger(year) || index === -1) {
    return null;
  }
  const next =
    index + 1 < KOLLEGIUMOK.length
      ? huBhgySlice(year, KOLLEGIUMOK[index + 1]?.slug ?? FIRST_SLUG)
      : huBhgySlice(year + 1, FIRST_SLUG);
  return next > sliceOf(new Date()) ? null : next;
};

const previousSlice = (slice: string): string | null => {
  const groups = SLICE_PATTERN.exec(slice)?.groups;
  const year = Number(groups?.["year"] ?? Number.NaN);
  const index = slugIndex(groups?.["slug"] ?? "");
  if (!Number.isInteger(year) || index === -1) {
    return null;
  }
  const previous =
    index > 0
      ? huBhgySlice(year, KOLLEGIUMOK[index - 1]?.slug ?? FIRST_SLUG)
      : huBhgySlice(year - 1, LAST_SLUG);
  return previous < HU_BHGY_FIRST_SLICE ? null : previous;
};

/**
 * Slices near the tip re-walked on a fast cadence: the current year's five
 * colleges and the previous year's. An older year a row lands in reaches the
 * ledger's short-slice backlog instead.
 */
const HU_BHGY_TIP_WINDOW = 10;

/**
 * One page of the publisher's listing for a slice.
 *
 * A saturated slice is a failure, deliberately. Neither of the two finer facets
 * the search offers partitions one: `HatarozatFajta` is unset on most older
 * rows and `JogTerulet` is nullable, so splitting on either would drop the rows
 * that state neither and record the slice as complete — rule 14's failure
 * exactly. Throwing holds the slice's previous ledger row and makes the ceiling
 * visible; the remedy is a finer slice grammar, which is a migration.
 */
const listHuBhgySlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const parsed = parseHuBhgySlice(slice);
  if (parsed === null) {
    return await Promise.reject(
      searchError(slice, `slice is not a year and a kollégium: ${slice}`),
    );
  }
  const listed = await search({
    cursor: slice,
    query: {
      year: parsed.year,
      kollegium: parsed.kollegium,
      sort: SORT.PUBLISHED_ASC,
      offset: page * MAX_PAGE_SIZE,
      pageSize: MAX_PAGE_SIZE,
    },
    signal,
  });
  if (Result.isError(listed)) {
    return await Promise.reject(listed.error);
  }
  const { count, rows } = listed.value;
  if (count >= SATURATION_COUNT) {
    return await Promise.reject(
      searchError(
        slice,
        `slice reports ${count} rows, the publisher's window ceiling; it cannot be listed to its end`,
      ),
    );
  }

  const items = rows.map((row) => ({
    identity: huBhgyListingIdentity(normalizeHuBhgyRow(row)),
    payload: row,
  }));
  return { items, totalPages: Math.ceil(count / MAX_PAGE_SIZE) };
};

const buildHuBhgyFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const attempted = await buildHuBhgyDecision({
    cursor: optionalString(payload["IndexId"]) ?? "",
    row: payload,
    ...(signal === undefined ? {} : { signal }),
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
      // Storing the listing observation here would make the identity held while
      // its document stayed unread, and the decision would leave every later
      // reconciliation.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled hu-bhgy build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Crawl cursor ─────────────────────────────────────────

type HuBhgyCursor =
  | {
      phase: "sweep";
      /** Newest publication timestamp when this sweep started. */
      boundary: string;
      year: number;
      slug: KollegiumSlug;
      offset: number;
    }
  | { phase: "tip"; frontier: string; offset: number };

const CURSOR_SEPARATOR = "|";

export const encodeHuBhgyCursor = (cursor: HuBhgyCursor): string =>
  cursor.phase === "sweep"
    ? [
        "sweep",
        cursor.boundary,
        String(cursor.year),
        cursor.slug,
        String(cursor.offset),
      ].join(CURSOR_SEPARATOR)
    : ["tip", cursor.frontier, String(cursor.offset)].join(CURSOR_SEPARATOR);

const isSlug = (value: string): value is KollegiumSlug =>
  KOLLEGIUM_BY_SLUG.has(value);

/**
 * Read a persisted cursor, or `null` for one this adapter does not write —
 * which is what a fresh source and a cursor from an older grammar both are, and
 * both mean "take the boundary and start the sweep".
 */
export const parseHuBhgyCursor = (
  cursor: string | null,
): HuBhgyCursor | null => {
  if (cursor === null) {
    return null;
  }
  const parts = cursor.split(CURSOR_SEPARATOR);
  const [phase] = parts;
  if (phase === "tip" && parts.length === 3) {
    const offset = Number(parts[2]);
    return parts[1] === undefined || !Number.isSafeInteger(offset)
      ? null
      : { phase: "tip", frontier: parts[1], offset };
  }
  if (phase !== "sweep" || parts.length !== 5) {
    return null;
  }
  const [, boundary, year, slug, offset] = parts;
  const yearValue = Number(year);
  const offsetValue = Number(offset);
  if (
    boundary === undefined ||
    slug === undefined ||
    !isSlug(slug) ||
    !Number.isSafeInteger(yearValue) ||
    !Number.isSafeInteger(offsetValue) ||
    yearValue < FIRST_YEAR
  ) {
    return null;
  }
  return {
    phase: "sweep",
    boundary,
    year: yearValue,
    slug,
    offset: offsetValue,
  };
};

/** The window after this one, or `null` past the newest year. */
const nextWindow = (
  year: number,
  slug: KollegiumSlug,
): { year: number; slug: KollegiumSlug } | null => {
  const index = slugIndex(slug);
  const next = KOLLEGIUMOK[index + 1];
  if (next !== undefined) {
    return { year, slug: next.slug };
  }
  return year + 1 > currentYear() ? null : { year: year + 1, slug: FIRST_SLUG };
};

/**
 * Whether a row's publication timestamp is one the frontier already covers.
 *
 * Instants, not text. The publisher writes the timestamp with its local UTC
 * offset, which moves between `+01:00` and `+02:00`, so around the switch two
 * timestamps sort one way as strings and the other way in time: a row printed
 * `02:15+01:00` is later than one printed `02:45+02:00`. Comparing the text
 * would step over rows the frontier has not reached.
 *
 * A timestamp neither side can read is treated as uncovered: re-reading a row
 * costs a request, and skipping one loses the decision.
 */
export const huBhgyCoveredByFrontier = (
  published: string,
  frontier: string,
): boolean => {
  const left = instantOrNull(published);
  const right = instantOrNull(frontier);
  return (
    left !== null &&
    right !== null &&
    Temporal.Instant.compare(left, right) <= 0
  );
};

const instantOrNull = (value: string): Temporal.Instant | null =>
  Result.try({
    try: () => Temporal.Instant.from(value),
    catch: () => null,
  }).unwrapOr(null);

/** The publisher's newest publication timestamp, in one request. */
const readBoundary = async (
  signal?: AbortSignal,
): Promise<Result<string, AdapterFetchError>> => {
  const listed = await search({
    cursor: "boundary",
    query: { sort: SORT.PUBLISHED_DESC, offset: 0, pageSize: 1 },
    signal,
  });
  if (Result.isError(listed)) {
    return listed;
  }
  const newest = listed.value.rows
    .map((row) => normalizeHuBhgyRow(row).IndexelesIdeje)
    .find((value) => value !== undefined);
  return Result.ok(newest ?? "");
};

type CollectOptions = {
  cursor: string;
  rows: Record<string, unknown>[];
  signal?: AbortSignal | undefined;
};

type Collected = { decisions: IngestionResult[]; aborted: boolean };

const collectDecisions = async ({
  cursor,
  rows,
  signal,
}: CollectOptions): Promise<Result<Collected, AdapterFetchError>> => {
  const decisions: IngestionResult[] = [];
  for (const row of rows) {
    if (signal?.aborted) {
      return Result.ok({ decisions, aborted: true });
    }
    const attempted = await buildHuBhgyDecision({ cursor, row, signal });
    if (Result.isError(attempted)) {
      return attempted;
    }
    const built = attempted.value;
    switch (built.type) {
      case "unkeyable":
        break;
      // The cursor moves past this document either way, so the crawl keeps the
      // listing-only row a download served nothing for; only the
      // reconciliation refuses it.
      case "detail-unavailable":
      case "built":
        decisions.push(built.decision);
        break;
      default: {
        built satisfies never;
        panic(`Unhandled hu-bhgy build result: ${JSON.stringify(built)}`);
      }
    }
  }
  return Result.ok({ decisions, aborted: false });
};

const sweepPage = async (
  start: Extract<HuBhgyCursor, { phase: "sweep" }>,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  let { offset, slug, year } = start;
  let url = "";

  for (let step = 0; step <= MAX_EMPTY_WINDOW_SKIPS; step += 1) {
    const cursor = encodeHuBhgyCursor({ ...start, year, slug, offset });
    const listed = await search({
      cursor,
      query: {
        year,
        kollegium: KOLLEGIUM_BY_SLUG.get(slug) ?? "",
        sort: SORT.PUBLISHED_ASC,
        offset,
        pageSize: CRAWL_PAGE_SIZE,
      },
      signal,
    });
    if (Result.isError(listed)) {
      return listed;
    }
    const { count, rows } = listed.value;
    url = listed.value.url;
    if (count >= SATURATION_COUNT) {
      return Result.err(
        searchError(
          cursor,
          `window ${year}/${slug} reports ${count} rows, the publisher's window ceiling; it cannot be walked to its end`,
        ),
      );
    }

    if (rows.length > 0) {
      const collected = await collectDecisions({ cursor, rows, signal });
      if (Result.isError(collected)) {
        return collected;
      }
      const { aborted, decisions } = collected.value;
      if (aborted) {
        // The cycle stopped partway through this page, so it says nothing about
        // the rows it never reached: parking at the page's own start replays it
        // rather than checkpointing past them.
        return Result.ok({ decisions, sourceUrl: url, nextCursor: cursor });
      }
      const nextOffset = offset + rows.length;
      if (nextOffset < count) {
        return Result.ok({
          decisions,
          sourceUrl: url,
          nextCursor: encodeHuBhgyCursor({
            ...start,
            year,
            slug,
            offset: nextOffset,
          }),
        });
      }
      const after = nextWindow(year, slug);
      return Result.ok({
        decisions,
        sourceUrl: url,
        nextCursor:
          after === null
            ? // Every window is swept. The tip takes over from the boundary
              // this sweep opened with, so nothing published while it ran is
              // behind the frontier (rule 19).
              encodeHuBhgyCursor({
                phase: "tip",
                frontier: start.boundary,
                offset: 0,
              })
            : encodeHuBhgyCursor({
                ...start,
                year: after.year,
                slug: after.slug,
                offset: 0,
              }),
      });
    }

    const after = nextWindow(year, slug);
    if (after === null) {
      return Result.ok({
        decisions: [],
        sourceUrl: url,
        nextCursor: encodeHuBhgyCursor({
          phase: "tip",
          frontier: start.boundary,
          offset: 0,
        }),
      });
    }
    year = after.year;
    slug = after.slug;
    offset = 0;
  }

  // Out of steps rather than out of windows: bank where the walk got to.
  return Result.ok({
    decisions: [],
    sourceUrl: url,
    nextCursor: encodeHuBhgyCursor({ ...start, year, slug, offset }),
  });
};

const tipPage = async (
  start: Extract<HuBhgyCursor, { phase: "tip" }>,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const cursor = encodeHuBhgyCursor(start);
  const listed = await search({
    cursor,
    query: {
      sort: SORT.PUBLISHED_DESC,
      offset: start.offset,
      pageSize: CRAWL_PAGE_SIZE,
    },
    signal,
  });
  if (Result.isError(listed)) {
    return listed;
  }
  const { rows, url } = listed.value;

  // Newest first, so the walk stops at the first row the frontier already
  // covers; everything before it is new.
  const fresh: Record<string, unknown>[] = [];
  let reachedFrontier = rows.length < CRAWL_PAGE_SIZE;
  for (const row of rows) {
    const published = normalizeHuBhgyRow(row).IndexelesIdeje ?? "";
    if (huBhgyCoveredByFrontier(published, start.frontier)) {
      reachedFrontier = true;
      break;
    }
    fresh.push(row);
  }

  if (fresh.length === 0) {
    // A quiet cycle: one request, and the cursor it was given.
    return Result.ok({ decisions: [], sourceUrl: url, nextCursor: cursor });
  }

  const collected = await collectDecisions({ cursor, rows: fresh, signal });
  if (Result.isError(collected)) {
    return collected;
  }
  const { aborted, decisions } = collected.value;
  if (aborted) {
    return Result.ok({ decisions, sourceUrl: url, nextCursor: cursor });
  }

  if (!reachedFrontier) {
    const nextOffset = start.offset + fresh.length;
    if (nextOffset >= MAX_TIP_PAGES * CRAWL_PAGE_SIZE) {
      // The catch-up is longer than a cycle should be. Advancing the frontier
      // to the oldest row consumed keeps every later cycle bounded, and what it
      // has not reached stays ahead of the new frontier.
      const oldest = normalizeHuBhgyRow(fresh.at(-1) ?? {}).IndexelesIdeje;
      return Result.ok({
        decisions,
        sourceUrl: url,
        nextCursor: encodeHuBhgyCursor({
          phase: "tip",
          frontier: oldest ?? start.frontier,
          offset: 0,
        }),
      });
    }
    // A descending listing only grows at its head, so resuming at this offset
    // can re-read a row but cannot step over one.
    return Result.ok({
      decisions,
      sourceUrl: url,
      nextCursor: encodeHuBhgyCursor({ ...start, offset: nextOffset }),
    });
  }

  const newest = normalizeHuBhgyRow(fresh[0] ?? {}).IndexelesIdeje;
  return Result.ok({
    decisions,
    sourceUrl: url,
    nextCursor: encodeHuBhgyCursor({
      phase: "tip",
      frontier: newest ?? start.frontier,
      offset: 0,
    }),
  });
};

const huBhgyFetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const parsed = parseHuBhgyCursor(cursor);
  if (parsed === null) {
    const boundary = await readBoundary(signal);
    if (Result.isError(boundary)) {
      return boundary;
    }
    return await sweepPage(
      {
        phase: "sweep",
        boundary: boundary.value,
        year: FIRST_YEAR,
        slug: FIRST_SLUG,
        offset: 0,
      },
      signal,
    );
  }
  return parsed.phase === "sweep"
    ? await sweepPage(parsed, signal)
    : await tipPage(parsed, signal);
};

// ── Total count ──────────────────────────────────────────

/**
 * How many decisions the collection holds, summed from the counts the search
 * itself states.
 *
 * The unfiltered count saturates, and so does most of the range, so the sum
 * runs per year and splits a saturated year across its five colleges. Those
 * five overlap — a decision filed under two colleges is counted twice — so what
 * comes back is the publisher's own arithmetic read as an upper bound, which is
 * the safe direction for a coverage denominator: it can only report a shortfall
 * that is not there, never hide one that is.
 */
const huBhgyTotalCount = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  let total = 0;
  for (let year = FIRST_YEAR; year <= currentYear(); year += 1) {
    const listed = await search({
      cursor: String(year),
      query: { year, sort: SORT.PUBLISHED_ASC, offset: 0, pageSize: 1 },
      signal,
    });
    if (Result.isError(listed)) {
      return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
    }
    if (listed.value.count < SATURATION_COUNT) {
      total += listed.value.count;
      continue;
    }
    for (const { value: kollegium } of KOLLEGIUMOK) {
      const part = await search({
        cursor: `${year}/${kollegium}`,
        query: {
          year,
          kollegium,
          sort: SORT.PUBLISHED_ASC,
          offset: 0,
          pageSize: 1,
        },
        signal,
      });
      if (Result.isError(part)) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }
      if (part.value.count >= SATURATION_COUNT) {
        // A college inside one year at the ceiling would make the sum a floor
        // of unknown depth rather than an upper bound.
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      total += part.value.count;
    }
  }
  return sourceTotalRead(total);
};

// ── Adapter ──────────────────────────────────────────────

export const huBhgyAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.HU_BHGY,
  language: HU_BHGY_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // A page is one listing request plus a download per row, all behind the
  // publisher gate, plus the empty-window steps `MAX_EMPTY_WINDOW_SKIPS` allows.
  pageTimeoutMs: 300_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparseHuBhgyStoredRaw,

  sourceSurfaces: HU_BHGY_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: HU_BHGY_SOURCE_FIELDS,
    listSourceFields: listHuBhgySourceFields,
  },

  getTotalCount: huBhgyTotalCount,

  reconciliation: {
    firstSlice: HU_BHGY_FIRST_SLICE,
    sliceOf,
    nextSlice,
    previousSlice,
    tipWindowDays: HU_BHGY_TIP_WINDOW,
    // A download failure leaves a listing-only row behind; unset, that row
    // would count as held and its document would never be hunted again.
    heldRequiresDetail: true,
    listSlicePage: listHuBhgySlicePage,
    buildDecision: buildHuBhgyFromPayload,
  },

  /**
   * The page's own refusals come back as `Err` from the walk; this wrapper is
   * for what the fetch layer raises instead of returning — a dropped
   * connection, an exhausted retry budget, a cycle abort.
   */
  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await huBhgyFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.HU_BHGY, cursor),
      }),
    );
  },
});
