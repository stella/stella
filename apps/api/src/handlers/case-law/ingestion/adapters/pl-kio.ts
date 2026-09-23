/**
 * Polish public-procurement rulings from the UZP decision database.
 *
 * orzeczenia.uzp.gov.pl publishes the rulings of the Krajowa Izba Odwoławcza
 * and the court rulings on complaints against them (district courts, and a
 * handful from the administrative courts and the Supreme Court). Three
 * surfaces per ruling, all HTML:
 *
 *   POST /Home/GetResults       the listing: ten rows a page, filtered by an
 *                               issue-date range (`Dt`), sorted by `Srt`
 *   GET  /Home/Details/{id}     the record: labelled fields, the appeals the
 *                               ruling decided and how, provisions, index
 *   GET  /Home/ContentHtml/{id} the document, converted from the original
 *
 * The listing states its own count (`resultCounts`), so a walk knows where a
 * window ends; asked for a page past the end, it serves the last page again
 * rather than an empty one, which is why every walk below stops on the count
 * and never on an empty page.
 *
 * Rows sort by issue date, then by id. The database also holds rulings with
 * no issue date, and a few dated past the present: no month the walk reaches
 * lists them, and the unfiltered ascending listing serves them last, the
 * undated ones in id order, so a later arrival appends. That tail is walked
 * once the months are caught up, and re-read on every parked cycle; the
 * day-sliced reconciliation cannot reach it.
 *
 * Cursor format: `YYYY-MM:offset+tail` — the month being walked and the row
 * offset reached inside it, oldest first, and the rows of the tail read so
 * far. At the present month the month part parks on its count.
 *
 * Overlap with `pl-courts`: SAOS mirrors KIO rulings until 2018 and holds
 * more of them for those years than this database does. The two sources have
 * separate id spaces; {@link plProcurementRulingKeys} is the relationship
 * between their rows, and nothing here merges or deletes either side.
 */

import { Result, panic } from "better-result";
import * as cheerio from "cheerio";

import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import { readCappedBytes } from "@stll/skills/streaming";
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
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  SOURCE_TOTAL_PROBE_FAILURE,
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
  SourceTotalCount,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
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

const ORIGIN = "https://orzeczenia.uzp.gov.pl";

const PL_KIO_HOST_POLICY = {
  type: "exact-origin",
  origins: [ORIGIN],
} as const;

const LISTING_PATH = "/Home/GetResults";

const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(ADAPTER_KEYS.PL_KIO);

/** Rows the listing serves a page; it takes no page-size parameter. */
const PL_KIO_PAGE_SIZE = 10;

const PL_KIO_LANGUAGE = "pl";

const PL_KIO_SOURCE_SYSTEM = "orzeczenia.uzp.gov.pl";

const PL_KIO_FIRST_SLICE =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_KIO].dateRange.fromInclusive;

const PL_KIO_FIRST_MONTH = PL_KIO_FIRST_SLICE.slice(0, 7);

/** Days near the tip the reconciliation re-walks on a fast cadence. */
const PL_KIO_TIP_WINDOW_DAYS = 14;

/**
 * Empty months one `fetchPage` may step over before it banks its progress.
 * The years before 2008 are almost all empty.
 */
const MAX_EMPTY_MONTH_SKIPS = 12;

/** The listing's sort keys. Ties on the date sort by id, ascending. */
const SORT = { DATE_ASC: "date_asc" } as const;

/**
 * Where each kind's count sits in `resultCounts`, which the search page reads
 * as `ALL,KIO,SO,SA,SN`.
 */
const RESULT_COUNT_INDEX = { ALL: 0, KIO: 1, SO: 2, SA: 3, SN: 4 } as const;

/** The categories the database files a ruling under. */
const PL_KIO_KINDS = ["KIO", "SO", "SA", "SN"] as const;

type PlKioKind = (typeof PL_KIO_KINDS)[number];

const isPlKioKind = (value: string): value is PlKioKind =>
  PL_KIO_KINDS.some((kind) => kind === value);

/** The placeholder the pages print for a field with no value. */
const NO_VALUE = "-";

// ── Text helpers ─────────────────────────────────────────

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

const presentText = (text: string | undefined): string | undefined => {
  if (text === undefined) {
    return undefined;
  }
  const collapsed = collapse(text);
  return collapsed.length === 0 || collapsed === NO_VALUE
    ? undefined
    : collapsed;
};

const DMY_DATE = /^(?<day>\d{2})-(?<month>\d{2})-(?<year>\d{4})$/u;

/** A `DD-MM-YYYY` date as ISO, or `undefined` for anything else. */
const plKioIsoDate = (value: string | undefined): string | undefined => {
  const groups = value === undefined ? undefined : DMY_DATE.exec(value)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  return isoOf(
    Number(groups["year"]),
    Number(groups["month"]),
    Number(groups["day"]),
  );
};

const isoOf = (year: number, month: number, day: number): string | undefined =>
  Result.try({
    try: () =>
      Temporal.PlainDate.from(
        { year, month, day },
        { overflow: "reject" },
      ).toString(),
    catch: () => null,
  }).unwrapOr(null) ?? undefined;

/** `dd-mm-yyyy`, the form the listing's date filter takes. */
const dmyOf = (iso: string): string =>
  `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

const POLISH_MONTHS = {
  stycznia: 1,
  lutego: 2,
  marca: 3,
  kwietnia: 4,
  maja: 5,
  czerwca: 6,
  lipca: 7,
  sierpnia: 8,
  września: 9,
  października: 10,
  listopada: 11,
  grudnia: 12,
} as const;

const isPolishMonth = (value: string): value is keyof typeof POLISH_MONTHS =>
  Object.hasOwn(POLISH_MONTHS, value);

/** How far into the text the header's date is looked for. */
const HEADER_DATE_WINDOW = 600;

const HEADER_DATE =
  /dnia\s+(?:(?<day>\d{1,2})\s+(?<monthName>\p{L}+)\s+(?<year>\d{4})|(?<dd>\d{1,2})\.(?<mm>\d{1,2})\.(?<yyyy>\d{4}))/iu;

/**
 * The issue date the document's own header states ("z dnia 28 lipca 2020 r.",
 * "Warszawa, dnia 1 września 2025 roku", "z dnia 07.12.2007 r."), for a
 * ruling the database lists with none. Only the header is read: a date later
 * in the text is a hearing or a filing, not the ruling.
 */
export const plKioHeaderDate = (fulltext: string): string | undefined => {
  const groups = HEADER_DATE.exec(
    fulltext.slice(0, HEADER_DATE_WINDOW),
  )?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const monthName = groups["monthName"]?.toLocaleLowerCase("pl-PL");
  if (monthName !== undefined) {
    return isPolishMonth(monthName)
      ? isoOf(
          Number(groups["year"]),
          POLISH_MONTHS[monthName],
          Number(groups["day"]),
        )
      : undefined;
  }
  return isoOf(
    Number(groups["yyyy"]),
    Number(groups["mm"]),
    Number(groups["dd"]),
  );
};

// ── Listing ──────────────────────────────────────────────

/** One row of the listing, keyed by the label the page prints. */
type PlKioListingItem = {
  id?: string | undefined;
  /** "Organ wydający". */
  court?: string | undefined;
  /** "Rodzaj dokumentu". */
  documentType?: string | undefined;
  /** "Sygnatura", joined appeals separated by `|`. */
  signature?: string | undefined;
  /** "Data wydania", `DD-MM-YYYY`, or absent where the page prints `-`. */
  issueDate?: string | undefined;
  /** The row's markup as served, so a field read later is still in the row. */
  html?: string | undefined;
};

const LISTING_LABELS = {
  "Organ wydający": "court",
  "Rodzaj dokumentu": "documentType",
  Sygnatura: "signature",
  "Data wydania": "issueDate",
} as const satisfies Record<string, keyof PlKioListingItem>;

const isListingLabel = (label: string): label is keyof typeof LISTING_LABELS =>
  Object.hasOwn(LISTING_LABELS, label);

const DETAILS_HREF = /^\/Home\/Details\/(?<id>\d+)$/u;

type PlKioListingPage = {
  /** `resultCounts`, in the page's own `ALL,KIO,SO,SA,SN` order. */
  counts: readonly [number, number, number, number, number];
  rows: PlKioListingItem[];
};

/**
 * Read a listing page, or `null` for anything that is not one.
 *
 * A page carries its count in a hidden input whatever it lists; a response
 * without it is an error page or a challenge, never an empty listing.
 */
export const readPlKioListing = (html: string): PlKioListingPage | null => {
  const $ = cheerio.load(html);
  const rawCounts = $("#resultCounts").attr("value");
  const counts = rawCounts?.split(",").map((part) => Number(part.trim()));
  if (
    counts?.length !== 5 ||
    !counts.every((count) => Number.isSafeInteger(count) && count >= 0)
  ) {
    return null;
  }
  const [all = 0, kio = 0, so = 0, sa = 0, sn = 0] = counts;

  const rows = $(".search-list-item")
    .toArray()
    .map((element) => {
      const item: PlKioListingItem = { html: $.html(element) };
      const node = $(element);
      node.find("label").each((_, label) => {
        const name = collapse($(label).text()).replace(/:$/u, "");
        if (!isListingLabel(name)) {
          return;
        }
        const parent = $(label).parent().clone();
        parent.find("label").remove();
        item[LISTING_LABELS[name]] = presentText(parent.text());
      });
      const href = node.find("a.link-details").attr("href");
      item.id =
        href === undefined
          ? undefined
          : DETAILS_HREF.exec(href)?.groups?.["id"];
      return item;
    });

  return { counts: [all, kio, so, sa, sn], rows };
};

/** Renormalize a stored or parked listing row; nothing is taken on faith. */
const normalizePlKioListingItem = (
  value: Record<string, unknown>,
): PlKioListingItem => {
  const text = (key: keyof PlKioListingItem): string | undefined => {
    const field = value[key];
    return typeof field === "string" && field.length > 0 ? field : undefined;
  };
  return {
    id: text("id"),
    court: text("court"),
    documentType: text("documentType"),
    signature: text("signature"),
    issueDate: text("issueDate"),
    html: text("html"),
  };
};

const QUARANTINE_ID_PREFIX = "uzp-quarantine:";

/**
 * The content-addressed identity of a counted row that states no record id.
 * Built from the fields that stay on the row when its link recovers, so the
 * repair that learns the id enriches the audited row instead of adding one.
 */
const plKioQuarantineId = (item: PlKioListingItem): string =>
  `${QUARANTINE_ID_PREFIX}${hashContent(
    JSON.stringify({
      court: item.court,
      documentType: item.documentType,
      signature: item.signature,
      issueDate: item.issueDate,
    }),
  )}`;

/** The database's own record id, where the row states a usable one. */
const publisherIdOf = (item: PlKioListingItem): string | undefined => {
  const { id } = item;
  return id !== undefined && isPersistableSourceDocumentId(id) ? id : undefined;
};

const sourceDocumentIdOf = (item: PlKioListingItem): string =>
  publisherIdOf(item) ?? plKioQuarantineId(item);

/**
 * The identity the ingest stores a listed row under: the database's own id,
 * which its record and document addresses are built from. A signature is not
 * one — the same appeal number recurs across a ruling and its correction. A
 * row with no usable id is kept under its quarantine identity.
 */
export const plKioListingIdentity = (
  item: PlKioListingItem,
): ListingIdentity => ({
  type: "document",
  sourceDocumentId: sourceDocumentIdOf(item),
});

// ── Detail record ────────────────────────────────────────

/** One appeal a ruling decided, as the record lists it. */
type PlKioCase = {
  caseNumber: string;
  /** For a court ruling: the chamber's own signature of the appeal reviewed. */
  reviewedCaseNumber?: string | undefined;
  /** How the appeal ended ("oddalone", "uwzględnione", "oddala skargę"…). */
  outcome?: string | undefined;
};

type PlKioDetail = {
  kind: PlKioKind | undefined;
  /** The page heading: the signature, and the only one a court ruling shows. */
  heading: string | undefined;
  /** Every labelled value, by the label the page prints. */
  fields: ReadonlyMap<string, string>;
  cases: PlKioCase[];
  /** Items of each titled list ("Kluczowe przepisy ustawy Pzp", …). */
  lists: ReadonlyMap<string, string[]>;
};

const CASE_LIST_LABELS = [
  "Sygnatura akt / Sposób rozstrzygnięcia",
  "Sygnatura akt / Sygnatura KIO / Sposób rozstrzygnięcia",
] as const;

const isCaseListLabel = (label: string): boolean =>
  CASE_LIST_LABELS.some((candidate) => candidate === label);

const CASE_SEPARATOR = " / ";

/**
 * One line of the case list. The outcome is always the last segment; a court
 * ruling puts the chamber's signature between. Split from the ends because an
 * early chamber signature can itself carry " / " ("KIO/UZP 192 / 08").
 */
export const plKioCaseOf = (
  line: string,
  withReviewed: boolean,
): PlKioCase[] => {
  const segments = collapse(line).split(CASE_SEPARATOR);
  const outcome = segments.length > 1 ? presentText(segments.pop()) : undefined;
  const [first, ...rest] = segments;
  const caseText = withReviewed ? first : segments.join(CASE_SEPARATOR);
  const reviewedCaseNumber = withReviewed
    ? presentText(rest.join(CASE_SEPARATOR))
    : undefined;
  // Joined appeals share one line, separated by `|`.
  return (caseText ?? "")
    .split("|")
    .map((part) => presentText(part))
    .filter((part) => part !== undefined)
    .map((caseNumber) => {
      const entry: PlKioCase = { caseNumber };
      if (reviewedCaseNumber !== undefined) {
        entry.reviewedCaseNumber = reviewedCaseNumber;
      }
      if (outcome !== undefined) {
        entry.outcome = outcome;
      }
      return entry;
    });
};

const KIND_HREF = /[?&]Kind=(?<kind>[A-Z]+)/u;

/**
 * Read the record page, or `null` for a page that is not one (the database's
 * "no such page" answer is a full HTML page under a 404, handled before).
 */
export const readPlKioDetail = (html: string): PlKioDetail | null => {
  const $ = cheerio.load(html);
  const metrics = $(".details-metrics");
  if (metrics.length === 0) {
    return null;
  }

  const heading = presentText(
    $("#pageContent h2.section-title")
      .first()
      .clone()
      .children()
      .remove()
      .end()
      .text(),
  );
  const kindHref = $('a[href^="/Home/PdfMetrics/"]').attr("href");
  const kindText =
    kindHref === undefined
      ? undefined
      : KIND_HREF.exec(kindHref)?.groups?.["kind"];
  const kind =
    kindText !== undefined && isPlKioKind(kindText) ? kindText : undefined;

  const fields = new Map<string, string>();
  const cases: PlKioCase[] = [];
  metrics.find("label").each((_, element) => {
    const label = collapse($(element).text());
    const container = $(element).parent();
    if (isCaseListLabel(label)) {
      // Recorded even when empty, so the inventory sees the label.
      fields.set(label, "");
      container.find("li").each((__, item) => {
        cases.push(
          ...plKioCaseOf(
            $(item).text(),
            label === "Sygnatura akt / Sygnatura KIO / Sposób rozstrzygnięcia",
          ),
        );
      });
      return;
    }
    const value = container.clone();
    value.find("label").remove();
    fields.set(label, collapse(value.text()));
  });

  const lists = new Map<string, string[]>();
  metrics.find("b").each((_, element) => {
    const title = collapse($(element).text());
    const items = $(element)
      .nextAll("p")
      .first()
      .find("a")
      .toArray()
      .flatMap((anchor) => $(anchor).text().split("|"))
      .map((item) => presentText(item))
      .filter((item) => item !== undefined);
    lists.set(title, items);
  });

  return { kind, heading, fields, cases, lists };
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every label and titled list the record page prints, across the four kinds.
 * A label outside this list is reported and kept verbatim on the row.
 */
const SOURCE_FIELDS = [
  "Organ wydający",
  "Rodzaj dokumentu",
  "Data wydania rozstrzygnięcia",
  "Przewodniczący",
  "Zamawiający",
  "Miejscowość",
  "Sygnatura akt / Sposób rozstrzygnięcia",
  "Sygnatura akt / Sygnatura KIO / Sposób rozstrzygnięcia",
  "Tryb postępowania",
  "Rodzaj zamówienia",
  "Izba",
  "Skarżony organ",
  "Wynik postępowania",
  "Kluczowe przepisy ustawy Pzp",
  "Zagadnienia merytoryczne w odwołaniu z Indeksu tematycznego",
] as const;

type PlKioSourceField = (typeof SOURCE_FIELDS)[number];

const isSourceField = (value: string): value is PlKioSourceField =>
  SOURCE_FIELDS.some((field) => field === value);

const PL_KIO_SOURCE_FIELDS = {
  "Organ wydający": {
    disposition: "stored",
    target: { type: "result", key: "court" },
  },
  "Rodzaj dokumentu": {
    disposition: "stored",
    target: { type: "metadata", key: "decisionForm" },
  },
  "Data wydania rozstrzygnięcia": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  Przewodniczący: {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  Zamawiający: {
    disposition: "stored",
    target: { type: "metadata", key: "contractingAuthority" },
  },
  Miejscowość: {
    disposition: "stored",
    target: { type: "metadata", key: "contractingAuthorityCity" },
  },
  "Sygnatura akt / Sposób rozstrzygnięcia": {
    disposition: "stored",
    target: { type: "metadata", key: "cases" },
  },
  "Sygnatura akt / Sygnatura KIO / Sposób rozstrzygnięcia": {
    disposition: "stored",
    target: { type: "metadata", key: "cases" },
  },
  "Tryb postępowania": {
    disposition: "stored",
    target: { type: "metadata", key: "procedure" },
  },
  "Rodzaj zamówienia": {
    disposition: "stored",
    target: { type: "metadata", key: "contractType" },
  },
  Izba: { disposition: "stored", target: { type: "metadata", key: "chamber" } },
  "Skarżony organ": {
    disposition: "stored",
    target: { type: "metadata", key: "challengedAuthority" },
  },
  "Wynik postępowania": {
    disposition: "stored",
    target: { type: "metadata", key: "outcome" },
  },
  "Kluczowe przepisy ustawy Pzp": {
    disposition: "stored",
    target: { type: "metadata", key: "legalBases" },
  },
  "Zagadnienia merytoryczne w odwołaniu z Indeksu tematycznego": {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
} as const satisfies Record<PlKioSourceField, SourceFieldDisposition>;

/** The envelope parts, named by the response each holds. */
const RAW_PART = {
  LISTING: "listing",
  DETAIL: "detail",
  DOCUMENT: "document",
} as const;

const listPlKioSourceFields = (parts: SourceRawParts): readonly string[] => {
  const detail = readPlKioDetail(parts[RAW_PART.DETAIL] ?? "");
  return detail === null
    ? []
    : [...detail.fields.keys(), ...detail.lists.keys()];
};

const SOURCE_SURFACES = [
  "listing",
  "detail",
  "document",
  "document-pdf",
  "detail-pdf",
  "results-pdf",
  "dictionaries",
] as const;

const PL_KIO_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    document: storedSourceSurface(RAW_PART.DOCUMENT),
    "document-pdf": excludedSourceSurface(
      "a print rendering of the same document the document part holds",
    ),
    "detail-pdf": excludedSourceSurface(
      "a print rendering of the record the detail part holds",
    ),
    "results-pdf": excludedSourceSurface(
      "a print rendering of a listing page, not a payload about one ruling",
    ),
    dictionaries: excludedSourceSurface(
      "corpus-wide completions for the search form, not about any one ruling",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Normalization ────────────────────────────────────────

const PL_KIO_DECISION_TYPES = [
  "wyrok",
  "postanowienie",
  "uchwała",
  "zarządzenie",
] as const;

/**
 * The decision type in the publisher's language. The record prints a longer
 * form for some rulings ("postanowienie w sprawie wniosku o uchylenie zakazu
 * zawarcia umowy"); the full form stays on the row as `decisionForm`.
 */
const plKioDecisionType = (form: string | undefined): string | undefined => {
  if (form === undefined) {
    return undefined;
  }
  const lowered = form.toLocaleLowerCase("pl-PL");
  const matched = PL_KIO_DECISION_TYPES.find(
    (type) => lowered === type || lowered.startsWith(`${type} `),
  );
  if (matched === undefined) {
    logger.warn("case_law.ingestion.decision_type_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_KIO,
      decisionForm: form,
    });
  }
  return matched;
};

const KIO_DOCKET = /^KIO(?:\/UZP)?\/?(?<ordinal>\d{1,5})\/+(?<year>\d{1,4})$/u;

/**
 * A signature in one spelling per appeal. The chamber has written the same
 * number as "KIO/UZP 1817//09", "KIO/UZP 192 / 08", "KIO/UZP/1/07" and, from
 * 2010, "KIO 1234/10"; the two sources do not agree on which, so a comparison
 * across them has to read all of them as one.
 */
export const normalizeProcurementDocket = (docket: string): string => {
  const compact = docket.toLocaleUpperCase("pl-PL").replace(/\s+/gu, "");
  const groups = KIO_DOCKET.exec(compact)?.groups;
  const ordinal = groups?.["ordinal"];
  const year = groups?.["year"];
  if (ordinal === undefined || year === undefined) {
    return collapse(docket).toLocaleUpperCase("pl-PL");
  }
  return `KIO ${Number(ordinal)}/${year.slice(-2).padStart(2, "0")}`;
};

/** What the ruling key is read from: stored columns only. */
type ProcurementRulingKeyInput = Pick<
  IngestionResult,
  "caseNumber" | "identifiers" | "court" | "decisionDate" | "decisionType"
>;

/**
 * The keys under which a stored ruling meets its copy in the other source:
 * issuing body, signature, issue date and decision type, one key per appeal
 * the ruling decided.
 *
 * Both this adapter and `pl-courts` store the same ruling under their own
 * publisher ids. Two rows sharing a key are one ruling; this database is the
 * official one and SAOS its mirror, so where both hold it the reader prefers
 * this row. Empty for a row missing the date or the type: a signature alone
 * does not name a ruling, since a judgment and a later order share it.
 */
export const plProcurementRulingKeys = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
  identifiers,
}: ProcurementRulingKeyInput): string[] => {
  if (decisionDate === undefined || decisionType === undefined) {
    return [];
  }
  const dockets = [
    caseNumber,
    // Absent identifiers mean the row states one docket, not a broken row.
    ...(identifiers === undefined
      ? []
      : identifiers
          .filter(({ type }) => type === DECISION_IDENTIFIER_TYPES.CASE_NUMBER)
          .map(({ value }) => value)),
  ];
  const issuer = collapse(court).toLocaleLowerCase("pl-PL");
  return [
    ...new Set(
      dockets.map(
        (docket) =>
          `${issuer}|${normalizeProcurementDocket(docket)}|${decisionDate}|${decisionType.toLocaleLowerCase("pl-PL")}`,
      ),
    ),
  ];
};

const detailUrlOf = (id: string): string => `${ORIGIN}/Home/Details/${id}`;

/** The document address the record page itself loads, highlighting off. */
const documentPathOf = (id: string, kind: PlKioKind | undefined): string =>
  kind === undefined
    ? `/Home/ContentHtml/${id}`
    : `/Home/ContentHtml/${id}?Kind=${kind}&flection=0`;

const documentUrlOf = (id: string, kind: PlKioKind | undefined): string =>
  `${ORIGIN}${documentPathOf(id, kind)}`;

type PlKioBuildResult =
  | { type: "built"; decision: IngestionResult }
  /**
   * Kept listing-only and unpublished: the record page is gone although the
   * listing still names the id, the row names no id to ask for, or nothing
   * states the issuing body. Each is quarantined with its reason.
   */
  | { type: "detail-unavailable"; decision: IngestionResult };

type AssemblePlKioDecisionOptions = {
  item: PlKioListingItem;
  /** The record page verbatim, where one was served. */
  detailHtml: string | undefined;
  /** The document verbatim, where one was served; empty is no document. */
  documentHtml: string | undefined;
};

const fieldOf = (
  detail: PlKioDetail | null,
  label: PlKioSourceField,
): string | undefined => presentText(detail?.fields.get(label));

/** The items of a titled list; a list the page does not print has none. */
const itemsOf = (
  detail: PlKioDetail | null,
  label: PlKioSourceField,
): string[] => {
  const items = detail?.lists.get(label);
  if (items === undefined) {
    return [];
  }
  return items;
};

const listOf = (
  detail: PlKioDetail | null,
  label: PlKioSourceField,
): string[] | undefined => {
  const items = itemsOf(detail, label);
  return items.length === 0 ? undefined : items;
};

/**
 * Build one ruling from the responses in hand. No I/O: the crawl, the
 * reconciliation and a replay of the stored envelope all reach this with the
 * same three payloads.
 */
export const assemblePlKioDecision = ({
  detailHtml,
  documentHtml,
  item,
}: AssemblePlKioDecisionOptions): PlKioBuildResult => {
  const id = publisherIdOf(item);
  const quarantineId = plKioQuarantineId(item);
  const sourceDocumentId = id ?? quarantineId;
  const detail =
    id === undefined || detailHtml === undefined
      ? null
      : readPlKioDetail(detailHtml);

  const dockets = [
    ...new Set(
      detail !== null && detail.cases.length > 0
        ? detail.cases.map(({ caseNumber }) => caseNumber)
        : (detail?.heading ?? item.signature ?? "")
            .split("|")
            .map((part) => presentText(part))
            .filter((part) => part !== undefined),
    ),
  ];
  const [statedCaseNumber, ...otherDockets] = dockets;
  // A row stating no signature is still a ruling the database counts; it is
  // kept under its identity as a placeholder docket rather than dropped.
  const caseNumber = statedCaseNumber ?? sourceDocumentId;

  const unmapped =
    detail === null
      ? {}
      : Object.fromEntries(
          [
            ...detail.fields,
            ...[...detail.lists].map(
              ([key, items]) => [key, items.join(" | ")] as const,
            ),
          ].filter(([label]) => !isSourceField(label)),
        );
  for (const label of Object.keys(unmapped)) {
    logger.warn("case_law.ingestion.source_field_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_KIO,
      field: label,
    });
  }

  // The database serves four kinds of issuing body, so a ruling that names
  // none is filed under none of them: it is kept unpublished with the reason,
  // and a later observation that states the body replaces it.
  const statedCourt =
    fieldOf(detail, "Organ wydający") ?? presentText(item.court);
  if (statedCourt === undefined) {
    logger.warn("case_law.ingestion.court_not_stated", {
      adapterKey: ADAPTER_KEYS.PL_KIO,
      sourceDocumentId,
    });
  }
  const court = statedCourt ?? "";
  let quarantineReason: "no-record-id" | "court-not-stated" | undefined;
  if (id === undefined) {
    quarantineReason = "no-record-id";
  } else if (statedCourt === undefined) {
    quarantineReason = "court-not-stated";
  }
  const listingOnly = detail === null || statedCourt === undefined;
  const decisionForm =
    fieldOf(detail, "Rodzaj dokumentu") ?? presentText(item.documentType);
  const decisionType = plKioDecisionType(decisionForm);
  const publishedDate =
    plKioIsoDate(fieldOf(detail, "Data wydania rozstrzygnięcia")) ??
    plKioIsoDate(item.issueDate);
  const legalBases = listOf(detail, "Kluczowe przepisy ustawy Pzp");
  const keywords = listOf(
    detail,
    "Zagadnienia merytoryczne w odwołaniu z Indeksu tematycznego",
  );

  const kind = detail?.kind;
  const content =
    documentHtml === undefined || documentHtml.trim().length === 0
      ? undefined
      : documentHtml;
  const parsed =
    content === undefined
      ? null
      : Result.try({
          try: () =>
            parsePlDecisionContent({
              caseNumber,
              ecli: undefined,
              court,
              decisionDate: publishedDate,
              decisionType,
              sourceUrl: id === undefined ? undefined : detailUrlOf(id),
              documentUrl:
                id === undefined ? undefined : documentUrlOf(id, kind),
              content,
              keywords: itemsOf(
                detail,
                "Zagadnienia merytoryczne w odwołaniu z Indeksu tematycznego",
              ),
              statutes: itemsOf(detail, "Kluczowe przepisy ustawy Pzp"),
              documentId: sourceDocumentId,
              sourceSystem: PL_KIO_SOURCE_SYSTEM,
            }),
          catch: errorTag,
        });
  if (parsed !== null && Result.isError(parsed)) {
    logger.warn("case_law.ingestion.document_parse_failed", {
      adapterKey: ADAPTER_KEYS.PL_KIO,
      caseNumber,
      "error.type": parsed.error,
    });
  }
  const document = parsed !== null && Result.isOk(parsed) ? parsed.value : null;
  const documentAst: DocumentAst | EmptyAst =
    document?.documentAst ?? EMPTY_AST;
  const fulltext = document?.fulltext;

  // The database lists some rulings with no issue date; their own header
  // states one, and the row says which of the two it carries.
  const headerDate =
    publishedDate === undefined && fulltext !== undefined
      ? plKioHeaderDate(fulltext)
      : undefined;
  const decisionDate = publishedDate ?? headerDate;
  let decisionDateSource: "publisher" | "document" | undefined;
  if (publishedDate !== undefined) {
    decisionDateSource = "publisher";
  } else if (headerDate !== undefined) {
    decisionDateSource = "document";
  }

  const presiding = fieldOf(detail, "Przewodniczący");
  const judges: DecisionJudgeInput[] | undefined =
    presiding === undefined
      ? undefined
      : [{ role: "presiding", nameAsPrinted: presiding }];

  const identifiers: DecisionIdentifier[] = otherDockets.map((value) => ({
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value,
  }));
  const [firstIdentifier, ...restIdentifiers] = identifiers;

  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.LISTING]: JSON.stringify(item),
    ...(detailHtml === undefined ? {} : { [RAW_PART.DETAIL]: detailHtml }),
    ...(documentHtml === undefined
      ? {}
      : { [RAW_PART.DOCUMENT]: documentHtml }),
  });

  const keyed: ProcurementRulingKeyInput = {
    caseNumber,
    identifiers:
      firstIdentifier === undefined
        ? undefined
        : [firstIdentifier, ...restIdentifiers],
    court,
    decisionDate,
    decisionType,
  };

  const decision: IngestionResult = {
    ...keyed,
    ...(statedCaseNumber === undefined
      ? { caseNumberIsPlaceholder: true }
      : {}),
    sourceDocumentId,
    // A row that recovers its id keeps meeting the row stored while it was
    // quarantined, so the repair enriches that row.
    ...(id === undefined
      ? {}
      : { sourceDocumentIdRepairAliases: [quarantineId] }),
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_KIO].country,
    language: PL_KIO_LANGUAGE,
    fulltext,
    ...(listingOnly ? { isListingOnly: true } : {}),
    ...(judges === undefined ? {} : { judges }),
    ...(id === undefined
      ? {}
      : { sourceUrl: detailUrlOf(id), documentUrl: documentUrlOf(id, kind) }),
    // The database publishes no thesis or abstract beside the ruling; its
    // subject index is stored as keywords.
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court,
      decisionDate,
      decisionType,
      decisionForm,
      documentId: id,
      quarantineReason,
      kind,
      decisionDateSource,
      presiding,
      cases: detail?.cases.length === 0 ? undefined : detail?.cases,
      contractingAuthority: fieldOf(detail, "Zamawiający"),
      contractingAuthorityCity: fieldOf(detail, "Miejscowość"),
      procedure: fieldOf(detail, "Tryb postępowania"),
      contractType: fieldOf(detail, "Rodzaj zamówienia"),
      chamber: fieldOf(detail, "Izba"),
      challengedAuthority: fieldOf(detail, "Skarżony organ"),
      outcome: fieldOf(detail, "Wynik postępowania"),
      legalBases,
      keywords,
      rulingKeys: plProcurementRulingKeys(keyed),
      ...(Object.keys(unmapped).length === 0
        ? {}
        : { unmappedFields: unmapped }),
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIO],
    documentAst,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };

  return listingOnly
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

// ── Requests ─────────────────────────────────────────────

const publisherError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `orzeczenia.uzp.gov.pl: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_KIO,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

type Requested = { status: number; body: string; url: string };

/**
 * The most a single response may hold. The largest document observed is a
 * quarter of a megabyte; anything past this is not a page this adapter reads.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const request = async ({
  cursor,
  form,
  path,
  signal,
  timeoutMs,
}: {
  cursor: string;
  form?: URLSearchParams | undefined;
  path: string;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}): Promise<Result<Requested, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_KIO_HOST_POLICY,
    rawUrl: `${ORIGIN}${path}`,
  });
  if (target === null) {
    return panic(`uzp request escaped the publisher origin: ${cursor}`);
  }
  const response = await fetchWithRetry(
    target.toString(),
    {
      method: form === undefined ? "GET" : "POST",
      body: form?.toString(),
      headers:
        form === undefined
          ? {}
          : {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
            },
      redirect: "error",
    },
    { adapterKey: ADAPTER_KEYS.PL_KIO, signal, timeoutMs },
  );
  const bytes =
    response.body === null
      ? new Uint8Array()
      : await readCappedBytes(response.body, MAX_RESPONSE_BYTES);
  if (bytes === null) {
    return Result.err(
      publisherError(
        cursor,
        `${path} answered more than ${MAX_RESPONSE_BYTES} bytes`,
        response.status,
      ),
    );
  }
  return Result.ok({
    status: response.status,
    body: new TextDecoder().decode(bytes),
    url: target.toString(),
  });
};

type ListOptions = {
  cursor: string;
  /** Inclusive ISO bounds; both absent lists the whole corpus. */
  range?: { from: string; to: string } | undefined;
  sort: (typeof SORT)[keyof typeof SORT];
  /** 1-based, as the listing numbers its pages. */
  page: number;
  signal?: AbortSignal | undefined;
};

type Listed = PlKioListingPage & {
  /** The count every page of this window is measured against. */
  total: number;
  url: string;
  form: string;
};

/**
 * How many rows a page must hold under a count: ten, the remainder on the
 * last page, and the last page again for a page past it, which is what the
 * listing serves there.
 */
const expectedRows = (total: number, page: number): number => {
  if (total === 0) {
    return 0;
  }
  const lastPage = Math.ceil(total / PL_KIO_PAGE_SIZE);
  const served = Math.min(page, lastPage);
  return Math.min(PL_KIO_PAGE_SIZE, total - (served - 1) * PL_KIO_PAGE_SIZE);
};

const listPage = async ({
  cursor,
  page,
  range,
  signal,
  sort,
}: ListOptions): Promise<Result<Listed, AdapterFetchError>> => {
  const form = new URLSearchParams({
    ...(range === undefined
      ? {}
      : { Dt: `${dmyOf(range.from)} - ${dmyOf(range.to)}` }),
    CountStats: "True",
    Srt: sort,
    Pg: String(page),
  });
  const requested = await request({
    cursor,
    form,
    path: LISTING_PATH,
    signal,
    timeoutMs: ADAPTER_TIMEOUT.LIST,
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const answered = requested.value;
  if (answered.status !== 200) {
    return Result.err(
      publisherError(
        cursor,
        `listing answered ${answered.status}`,
        answered.status,
      ),
    );
  }
  const listing = readPlKioListing(answered.body);
  if (listing === null) {
    return Result.err(
      publisherError(cursor, "listing answered a page with no result count"),
    );
  }
  const total = listing.counts[RESULT_COUNT_INDEX.ALL];
  const expected = expectedRows(total, page);
  if (listing.rows.length !== expected) {
    // The count promises rows the markup did not yield: unknown markup, not
    // a shorter window, so nothing past them may be checkpointed.
    return Result.err(
      publisherError(
        cursor,
        `listing page ${page} held ${listing.rows.length} rows where its count of ${total} promises ${expected}`,
      ),
    );
  }
  return Result.ok({
    ...listing,
    total,
    url: answered.url,
    form: form.toString(),
  });
};

/**
 * The rows a listed page holds for offsets `offset` onwards, or none where the
 * offset is at or past the count: the listing answers such a page with the
 * last one again, and those rows were read already.
 */
const rowsFrom = (listed: Listed, offset: number): PlKioListingItem[] =>
  offset >= listed.total ? [] : listed.rows.slice(offset % PL_KIO_PAGE_SIZE);

const pageOf = (offset: number): number =>
  Math.floor(offset / PL_KIO_PAGE_SIZE) + 1;

type FetchRulingOptions = {
  cursor: string;
  item: PlKioListingItem;
  signal?: AbortSignal | undefined;
};

/**
 * Fetch the record and the document of a listed ruling, then assemble it. A
 * refused request is the item's failure, never its absence; only the
 * database's own "no such page" is read as a record that is gone.
 */
const fetchPlKioDecision = async ({
  cursor,
  item,
  signal,
}: FetchRulingOptions): Promise<
  Result<PlKioBuildResult, AdapterFetchError>
> => {
  const id = publisherIdOf(item);
  if (id === undefined) {
    // Nothing to ask the database for: the row itself is what is kept.
    return Result.ok(
      assemblePlKioDecision({
        item,
        detailHtml: undefined,
        documentHtml: undefined,
      }),
    );
  }
  const detailRequested = await request({
    cursor,
    path: `/Home/Details/${id}`,
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (Result.isError(detailRequested)) {
    return detailRequested;
  }
  const detail = detailRequested.value;
  if (detail.status === 404 || detail.status === 410) {
    return Result.ok(
      assemblePlKioDecision({
        item,
        detailHtml: undefined,
        documentHtml: undefined,
      }),
    );
  }
  const record = detail.status === 200 ? readPlKioDetail(detail.body) : null;
  if (record === null) {
    return Result.err(
      publisherError(
        cursor,
        `record ${id} answered ${detail.status}`,
        detail.status,
      ),
    );
  }
  const contentRequested = await request({
    cursor,
    path: documentPathOf(id, record.kind),
    signal,
    timeoutMs: ADAPTER_TIMEOUT.PAGE,
  });
  if (Result.isError(contentRequested)) {
    return contentRequested;
  }
  const content = contentRequested.value;
  if (content.status === 404 || content.status === 410) {
    // A record whose document is gone is still the record: stored with no
    // document, which the pipeline keeps unpublished and re-asks for.
    return Result.ok(
      assemblePlKioDecision({
        item,
        detailHtml: detail.body,
        documentHtml: undefined,
      }),
    );
  }
  if (content.status !== 200) {
    return Result.err(
      publisherError(
        cursor,
        `document ${id} answered ${content.status}`,
        content.status,
      ),
    );
  }
  return Result.ok(
    assemblePlKioDecision({
      item,
      detailHtml: detail.body,
      documentHtml: content.body,
    }),
  );
};

// ── Replay ───────────────────────────────────────────────

const reparsePlKioStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: (listing) =>
      sourceDocumentIdOf(normalizePlKioListingItem(listing)),
  });
  if (read.type === "rejected") {
    return read;
  }
  const built = assemblePlKioDecision({
    item: normalizePlKioListingItem(read.listing),
    detailHtml: read.parts[RAW_PART.DETAIL],
    documentHtml: read.parts[RAW_PART.DOCUMENT],
  });
  return { type: "parsed", result: built.decision };
};

// ── Crawl cursor ─────────────────────────────────────────

const CURSOR_PATTERN =
  /^(?<month>\d{4}-(?:0[1-9]|1[0-2])):(?<offset>\d+)\+(?<tail>\d+)$/u;

type PlKioCursor = { month: string; offset: number; tail: number };

export const parsePlKioCursor = (cursor: string | null): PlKioCursor => {
  const groups =
    cursor === null ? undefined : CURSOR_PATTERN.exec(cursor)?.groups;
  const month = groups?.["month"];
  const offset = Number(groups?.["offset"]);
  const tail = Number(groups?.["tail"]);
  if (
    month === undefined ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(tail)
  ) {
    return { month: PL_KIO_FIRST_MONTH, offset: 0, tail: 0 };
  }
  return { month, offset, tail };
};

export const encodePlKioCursor = ({
  month,
  offset,
  tail,
}: PlKioCursor): string => `${month}:${offset}+${tail}`;

const currentMonth = (): string =>
  Temporal.Now.plainDateISO("UTC").toPlainYearMonth().toString();

const monthAfter = (month: string): string | null => {
  const next = Temporal.PlainYearMonth.from(month)
    .add({ months: 1 })
    .toString();
  return next > currentMonth() ? null : next;
};

const monthRange = (month: string): { from: string; to: string } => {
  const yearMonth = Temporal.PlainYearMonth.from(month);
  return {
    from: `${month}-01`,
    to: `${month}-${String(yearMonth.daysInMonth).padStart(2, "0")}`,
  };
};

/**
 * The earliest date the tail count starts from. Nothing the database dates
 * is older; the manifest's first slice is what the search answers with.
 */
const DATED_FLOOR = "1900-01-01";

// ── Crawl ────────────────────────────────────────────────

type Window = {
  cursor: PlKioCursor;
  listed: Listed;
  rows: PlKioListingItem[];
  /** The present month, read to its count. */
  atTip: boolean;
};

/** The next month holding rows at or after the cursor, with its page. */
const advanceToPopulatedMonth = async (
  start: PlKioCursor,
  signal?: AbortSignal,
): Promise<Result<Window, AdapterFetchError>> => {
  let { month, offset } = start;
  let last: Window | undefined;
  for (let step = 0; step <= MAX_EMPTY_MONTH_SKIPS; step += 1) {
    const cursor = { month, offset, tail: start.tail };
    const listed = await listPage({
      cursor: encodePlKioCursor(cursor),
      range: monthRange(month),
      sort: SORT.DATE_ASC,
      page: pageOf(offset),
      signal,
    });
    if (Result.isError(listed)) {
      return listed;
    }
    const rows = rowsFrom(listed.value, offset);
    last = { cursor, listed: listed.value, rows, atTip: false };
    if (rows.length > 0) {
      return Result.ok(last);
    }
    const next = monthAfter(month);
    if (next === null) {
      return Result.ok({
        ...last,
        cursor: { ...cursor, offset: Math.max(offset, listed.value.total) },
        atTip: true,
      });
    }
    month = next;
    offset = 0;
  }
  return last === undefined
    ? panic("the month walk made no request")
    : Result.ok(last);
};

type Built = { decisions: IngestionResult[]; aborted: boolean };

const buildRows = async (
  rows: readonly PlKioListingItem[],
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<Built, AdapterFetchError>> => {
  const decisions: IngestionResult[] = [];
  for (const item of rows) {
    if (signal?.aborted) {
      return Result.ok({ decisions, aborted: true });
    }
    const attempted = await fetchPlKioDecision({ cursor, item, signal });
    if (Result.isError(attempted)) {
      return attempted;
    }
    const built = attempted.value;
    switch (built.type) {
      case "detail-unavailable":
      case "built":
        decisions.push(built.decision);
        break;
      default: {
        built satisfies never;
        panic(`Unhandled pl-kio build result: ${JSON.stringify(built)}`);
      }
    }
  }
  return Result.ok({ decisions, aborted: false });
};

/**
 * One page of the tail: the unfiltered ascending listing past every row
 * dated up to the present month's end. Its start moves as dated rulings
 * arrive, so the cursor holds the position inside the tail rather than in
 * the listing.
 */
const fetchTailPage = async (
  parked: PlKioCursor,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const cursor = encodePlKioCursor(parked);
  const dated = await listPage({
    cursor,
    range: { from: DATED_FLOOR, to: monthRange(currentMonth()).to },
    sort: SORT.DATE_ASC,
    page: 1,
    signal,
  });
  if (Result.isError(dated)) {
    return dated;
  }
  const start = dated.value.total + parked.tail;
  const listed = await listPage({
    cursor,
    sort: SORT.DATE_ASC,
    page: pageOf(start),
    signal,
  });
  if (Result.isError(listed)) {
    return listed;
  }
  const rows = rowsFrom(listed.value, start);
  const built = await buildRows(rows, cursor, signal);
  if (Result.isError(built)) {
    return built;
  }
  const { decisions, aborted } = built.value;
  return Result.ok({
    decisions,
    sourceUrl: listed.value.url,
    nextCursor: aborted
      ? cursor
      : encodePlKioCursor({ ...parked, tail: parked.tail + rows.length }),
  });
};

const plKioFetchPage = async (
  rawCursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const advanced = await advanceToPopulatedMonth(
    parsePlKioCursor(rawCursor),
    signal,
  );
  if (Result.isError(advanced)) {
    return advanced;
  }
  const { atTip, cursor, listed, rows } = advanced.value;
  if (atTip) {
    // The months are caught up: the rest of this cycle reads the tail.
    return await fetchTailPage(cursor, signal);
  }
  const built = await buildRows(rows, encodePlKioCursor(cursor), signal);
  if (Result.isError(built)) {
    return built;
  }
  const { decisions, aborted } = built.value;
  if (aborted) {
    // Replay the page rather than checkpoint past rows never reached.
    return Result.ok({
      decisions,
      sourceUrl: listed.url,
      nextCursor: encodePlKioCursor(cursor),
    });
  }
  const reached = cursor.offset + rows.length;
  if (reached < listed.total) {
    return Result.ok({
      decisions,
      sourceUrl: listed.url,
      nextCursor: encodePlKioCursor({ ...cursor, offset: reached }),
    });
  }
  const next = monthAfter(cursor.month);
  return Result.ok({
    decisions,
    sourceUrl: listed.url,
    nextCursor: encodePlKioCursor(
      next === null
        ? { ...cursor, offset: reached }
        : { month: next, offset: 0, tail: cursor.tail },
    ),
  });
};

// ── Reconciliation ───────────────────────────────────────

const plKioDaySlices = createCalendarDaySliceWalk({
  firstSlice: PL_KIO_FIRST_SLICE,
  source: ADAPTER_KEYS.PL_KIO,
});

/**
 * One page of the listing for an issue date. The page count comes from the
 * listing's own count, so a slice ends where the publisher says it does.
 */
const listPlKioSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const listed = await listPage({
    cursor: slice,
    range: { from: slice, to: slice },
    sort: SORT.DATE_ASC,
    page: page + 1,
    signal,
  });
  if (Result.isError(listed)) {
    return await Promise.reject(listed.error);
  }
  const totalPages = Math.ceil(listed.value.total / PL_KIO_PAGE_SIZE);
  const rows = rowsFrom(listed.value, page * PL_KIO_PAGE_SIZE);
  return {
    items: rows.map((row) => ({
      identity: plKioListingIdentity(row),
      payload: row,
    })),
    totalPages,
  };
};

const buildPlKioFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const item = normalizePlKioListingItem(payload);
  const attempted = await fetchPlKioDecision({
    cursor: item.issueDate ?? sourceDocumentIdOf(item),
    item,
    signal,
  });
  if (Result.isError(attempted)) {
    return await Promise.reject(attempted.error);
  }
  const built = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "detail-unavailable":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-kio build result: ${JSON.stringify(built)}`);
    }
  }
};

/** The whole corpus's count, as the listing states it with no filter. */
const plKioTotalCount = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const listed = await Result.tryPromise({
    try: async () =>
      await listPage({ cursor: "total", sort: SORT.DATE_ASC, page: 1, signal }),
    catch: errorTag,
  });
  if (Result.isError(listed)) {
    return { type: "probe-failed", errorTag: listed.error };
  }
  return Result.isError(listed.value)
    ? sourceTotalProbeFailed(
        listed.value.error.httpStatus === undefined
          ? SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD
          : SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS,
      )
    : sourceTotalRead(listed.value.value.total);
};

// ── Adapter ──────────────────────────────────────────────

export const plKioAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_KIO,
  language: PL_KIO_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // A page is a listing request plus a record and a document per row (ten at
  // most), all behind the gate, plus up to a dozen empty-month steps.
  pageTimeoutMs: 300_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparsePlKioStoredRaw,

  sourceSurfaces: PL_KIO_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_KIO_SOURCE_FIELDS,
    listSourceFields: listPlKioSourceFields,
  },

  getTotalCount: plKioTotalCount,

  reconciliation: {
    firstSlice: PL_KIO_FIRST_SLICE,
    ...plKioDaySlices.walk,
    tipWindowDays: PL_KIO_TIP_WINDOW_DAYS,
    heldRequiresDetail: true,
    listSlicePage: listPlKioSlicePage,
    buildDecision: buildPlKioFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plKioFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_KIO, cursor),
      }),
    );
  },
});
