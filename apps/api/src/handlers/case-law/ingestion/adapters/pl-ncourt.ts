/**
 * Polish common courts from the Ministry of Justice's judgments API.
 *
 * apiorzeczenia.wroclaw.sa.gov.pl/ncourt-api serves the judgments the courts
 * of appeal, the regional and the district courts publish on their portals.
 * Three endpoints, all XML:
 *
 *   /judgements            the listing: `offset`/`limit` pages, filterable by
 *                          court, judgment date and publication date, sortable
 *                          by signature; the root states `total`
 *   /judgement/details?id= the record: bench, subject phrases, statutes,
 *                          clerks, publication dates
 *   /judgement/content?id= the document, in the courts' own `xPart` markup
 *
 * Identity is the API's own id (`151015150000503_I_1@C_001047_2015_Uz_…_001`),
 * which is also what SAOS stores as `source.judgmentId` for its copy. Two
 * behaviours of the listing shape everything below:
 *
 * - A filter it does not recognise is dropped without a word: an unknown
 *   court id answers the whole corpus. A filtered read therefore checks that
 *   the filter took effect before trusting its count or its rows.
 * - A window holding a record the API cannot serialise answers 404 as a whole.
 *   The walk halves the window until the record is isolated, stores it as a
 *   quarantined audit row under its position, and moves past it.
 *
 * Crawl cursor: two lanes, one listing request per page.
 *
 *   walk:<since>:<offset>:<window>:<anchor>     by signature, everything
 *                                               published before `since`
 *   tip:<from>:<to>:<offset>:<window>:<anchor>  by signature, everything
 *                                               published from `from` up to
 *                                               (not including) `to`
 *
 * `anchor` is the id of the last row read, which the next page must list
 * first; see {@link PlNcourtCursor}.
 *
 * Each lane pages a set frozen by publication day: the walk what was
 * published before the day it began, a tip lap what was published from the
 * day the previous one stopped before, up to (not including) the day the
 * lap started. The tip takes over exactly where the walk stops, and a lap
 * runs once per closed day: a cycle on the day the last lap ended makes no
 * request and returns its cursor unchanged.
 *
 * Overlap with `pl-courts`: SAOS imports from this API. Both adapters keep
 * their own rows; {@link plCommonCourtRulingKeys} is the relationship between
 * them, and nothing here merges or deletes either side.
 */

import { Result, panic } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import { readCappedBytes } from "@stll/skills/streaming";
import { parsePlainDate, Temporal } from "@stll/time";

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
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  DecisionSupplement,
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationListingItem,
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
import {
  PL_COURTS_RULING_DECISION_TYPES,
  PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { PL_NCOURT_COURT_NAMES } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt-courts";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  readPlNcourtContent,
  validatePlNcourtDocument,
} from "@/api/handlers/case-law/ingestion/parsers/pl-ncourt";
import type { PlNcourtContent } from "@/api/handlers/case-law/ingestion/parsers/pl-ncourt";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { arrayOrEmpty } from "@/api/lib/array";
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
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const ORIGIN = "https://apiorzeczenia.wroclaw.sa.gov.pl";

const API_PATH = "/ncourt-api";

const PL_NCOURT_HOST_POLICY = {
  type: "exact-origin",
  origins: [ORIGIN],
} as const;

/** The portal every court's judgments are read at. */
const PORTAL_ORIGIN = "https://orzeczenia.ms.gov.pl";

const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(
  ADAPTER_KEYS.PL_NCOURT,
);

const PL_NCOURT_LANGUAGE = "pl";

const PL_NCOURT_SOURCE_SYSTEM = "orzeczenia.ms.gov.pl";

const PL_NCOURT_FIRST_SLICE =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_NCOURT].dateRange.fromInclusive;

/**
 * Rows one crawl page lists and builds. Each costs a record and a document
 * request behind the gate, and a listing deep in the corpus costs tens of
 * seconds whatever its size, so the window is as wide as a page's time allows.
 */
export const PL_NCOURT_WINDOW = 200;

/** Rows one reconciliation page lists; a judgment date rarely holds more. */
const PL_NCOURT_SLICE_ROWS = 500;

/** Days near the tip the reconciliation re-walks on a fast cadence. */
const PL_NCOURT_TIP_WINDOW_DAYS = 14;

/** The only order the listing keeps stable across requests. */
const SORT_BY_SIGNATURE = "signature-asc";

// ── Values as printed ────────────────────────────────────

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

const presentText = (text: string | undefined): string | undefined => {
  if (text === undefined) {
    return undefined;
  }
  const collapsed = collapse(text);
  return collapsed.length === 0 ? undefined : collapsed;
};

const PRINTED_INSTANT =
  /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2})(?:\.\d+)? (?<zone>CEST|CET|UTC|GMT)$/u;

/**
 * The calendar day a printed timestamp names, as printed.
 *
 * A judgment date is stored as local midnight ("2015-10-16 02:00:00.0 CEST"
 * is the 16th), so the day is the printed one and never a conversion.
 */
export const plNcourtDay = (value: string | undefined): string | undefined => {
  const day = value === undefined ? undefined : PRINTED_INSTANT.exec(value);
  const date = day?.groups?.["date"];
  if (date === undefined) {
    return undefined;
  }
  const parsed = parsePlainDate(date);
  return parsed !== null && parsed.year >= 1900 ? parsed.toString() : undefined;
};

// ── Listing ──────────────────────────────────────────────

/** One listed judgment, each element as printed. */
type PlNcourtListingRow = {
  id?: string | undefined;
  signature?: string | undefined;
  date?: string | undefined;
  publicationDate?: string | undefined;
  lastUpdate?: string | undefined;
  courtId?: string | undefined;
  departmentId?: string | undefined;
  type?: string | undefined;
  excerpt?: string | undefined;
  /** The thesis, where the listing states one; the record states it too. */
  thesis?: string | undefined;
};

const LISTING_ROW_FIELDS = [
  "id",
  "signature",
  "date",
  "publicationDate",
  "lastUpdate",
  "courtId",
  "departmentId",
  "type",
  "excerpt",
  "thesis",
] as const satisfies readonly (keyof PlNcourtListingRow)[];

const isListingRowField = (
  name: string,
): name is (typeof LISTING_ROW_FIELDS)[number] =>
  LISTING_ROW_FIELDS.some((field) => field === name);

type PlNcourtListing = {
  /** `total`: how many judgments the request's filters match. */
  total: number;
  /**
   * Each row's `<judgement>` element exactly as the listing printed it:
   * what the row stores, so a field read later is read off the publisher's
   * bytes rather than this adapter's reading of them.
   */
  fragments: string[];
  rows: PlNcourtListingRow[];
};

/** Renormalize a listed, stored or parked row; nothing is taken on faith. */
export const normalizePlNcourtListingRow = (
  value: Record<string, unknown>,
): PlNcourtListingRow => {
  const row: PlNcourtListingRow = {};
  for (const field of LISTING_ROW_FIELDS) {
    const text = value[field];
    if (typeof text === "string" && text.length > 0) {
      row[field] = text;
    }
  }
  return row;
};

/** A listed row's elements this adapter has no name for. */
const unmappedListingFields = (
  record: Record<string, unknown>,
): [string, string][] =>
  Object.entries(record).flatMap(([name, value]) =>
    isListingRowField(name) || typeof value !== "string" ? [] : [[name, value]],
  );

/** The text an element holds, marks and all. */
const textOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  return isTag(node) ? node.children.map(textOf).join("") : "";
};

const childElements = (element: Element): Element[] =>
  element.children.filter((child): child is Element => isTag(child));

const rootElement = (xml: string): Element | undefined => {
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first().get(0);
  return root !== undefined && isTag(root) ? root : undefined;
};

/** Every element a row prints, by name, including any nothing here names. */
const elementsOf = (element: Element): Record<string, string> =>
  Object.fromEntries(
    childElements(element).flatMap((field) => {
      const value = presentText(textOf(field));
      return value === undefined ? [] : [[field.name, value] as const];
    }),
  );

/**
 * One listed row read back from its stored `<judgement>` element, or `null`
 * for anything that is not one.
 */
export const readPlNcourtListingRow = (
  fragment: string,
): Record<string, string> | null => {
  const root = rootElement(fragment);
  return root?.name === "judgement" ? elementsOf(root) : null;
};

/**
 * Read a listing page, or `null` for anything that is not one: an `<error>`
 * answer, an HTML page, a body with no count. A page that states rows it
 * does not carry is refused too; an undercounted page would read as the end.
 */
export const readPlNcourtListing = (xml: string): PlNcourtListing | null => {
  const $ = cheerio.load(xml, {
    xml: { xmlMode: true, withStartIndices: true, withEndIndices: true },
  });
  const root = $.root().children().first().get(0);
  const total = Number(root?.attribs["total"]);
  if (
    root?.name !== "judgements" ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    return null;
  }
  const elements = childElements(root).filter(
    (element) => element.name === "judgement",
  );
  const results = Number(root.attribs["results"]);
  if (Number.isSafeInteger(results) && results !== elements.length) {
    return null;
  }
  const fragments = elements.map((element) =>
    element.startIndex === null || element.endIndex === null
      ? $.xml(element)
      : xml.slice(element.startIndex, element.endIndex + 1),
  );
  return {
    total,
    fragments,
    rows: elements.map((element) =>
      normalizePlNcourtListingRow(elementsOf(element)),
    ),
  };
};

// ── Detail record ────────────────────────────────────────

/** The record's list elements and the element each item is printed as. */
const DETAIL_LISTS = {
  judges: "judge",
  themePhrases: "themePhrase",
  references: "reference",
  legalBases: "legalBasis",
} as const;

type DetailListField = keyof typeof DETAIL_LISTS;

const isDetailListField = (name: string): name is DetailListField =>
  Object.hasOwn(DETAIL_LISTS, name);

type PlNcourtDetail =
  | {
      type: "record";
      /** The id the record states for itself. */
      id: string | undefined;
      /** Every single-valued element, by the name printed. */
      fields: ReadonlyMap<string, string>;
      /** Every list element's items, by the list's name. */
      lists: ReadonlyMap<string, string[]>;
    }
  /** The API's own "not found" for an id, served as a 200 `<error>`. */
  | { type: "not-found"; message: string };

const NOT_FOUND_MESSAGE = /not found/iu;

/**
 * Read the record, or `null` for anything that is neither a record nor the
 * API's own "not found": an HTML page, another error, an empty body.
 */
export const readPlNcourtDetail = (xml: string): PlNcourtDetail | null => {
  const root = rootElement(xml);
  if (root === undefined) {
    return null;
  }
  if (root.name === "error") {
    const message = collapse(textOf(root));
    return NOT_FOUND_MESSAGE.test(message)
      ? { type: "not-found", message }
      : null;
  }
  if (root.name !== "judgement") {
    return null;
  }
  const fields = new Map<string, string>();
  const lists = new Map<string, string[]>();
  for (const element of childElements(root)) {
    if (isDetailListField(element.name)) {
      const itemName = DETAIL_LISTS[element.name];
      lists.set(
        element.name,
        childElements(element)
          .filter((item) => item.name === itemName)
          .map((item) => presentText(textOf(item)))
          .filter((item) => item !== undefined),
      );
      continue;
    }
    fields.set(element.name, collapse(textOf(element)));
  }
  return { type: "record", id: presentText(root.attribs["id"]), fields, lists };
};

// ── Source-field inventory ───────────────────────────────

/**
 * The envelope parts, named by the response each holds, every one verbatim:
 * the listed `<judgement>` element, the record, the document. A document the
 * API answered 404 for is stated as that status, and a row the listing could
 * not serve at all as its quarantine record.
 */
const RAW_PART = {
  LISTING: "listing",
  DETAIL: "detail",
  DOCUMENT: "document",
  DOCUMENT_STATUS: "document-status",
  QUARANTINE: "quarantine",
} as const;

/** The document's root attributes, as the inventory names them. */
const CONTENT_ATTRIBUTE_PREFIX = "xPart@";

/**
 * Every name the three responses state for a judgment: the listing row's and
 * the record's elements (one name where both print it), the document's root
 * name and attributes, and the document itself.
 */
const SOURCE_FIELDS = [
  "id",
  "signature",
  "date",
  "publicationDate",
  "lastUpdate",
  "courtId",
  "departmentId",
  "type",
  "excerpt",
  "chairman",
  "judges",
  "themePhrases",
  "references",
  "legalBases",
  "recorder",
  "decision",
  "reviser",
  "publisher",
  "dateOfPublication",
  "dateOfLastUpdate",
  "thesis",
  "xPart",
  "xPart/xName",
  "xPart@xVersion",
  "xPart@xLang",
  "xPart@xYear",
  "xPart@xDocType",
  "xPart@xVolType",
  "xPart@xVolNmbr",
  "xPart@xFromPg",
  "xPart@xToPage",
  "xPart@xFlag",
  "xPart@xEditor",
  "xPart@xEditorFullName",
  "xPart@xPublisher",
  "xPart@xPublisherFullName",
  "xPart@xClassifier",
  "xPart@xClassifierFullName",
  "xPart@xClassified",
  "xPart@xml:space",
] as const;

type PlNcourtSourceField = (typeof SOURCE_FIELDS)[number];

const isSourceField = (value: string): value is PlNcourtSourceField =>
  SOURCE_FIELDS.some((field) => field === value);

const DOCUMENT_FIELD = {
  disposition: "stored",
  target: { type: "metadata", key: "document" },
} as const satisfies SourceFieldDisposition;

const JUDGES_FIELD = {
  disposition: "stored",
  target: { type: "result", key: "judges" },
} as const satisfies SourceFieldDisposition;

const PL_NCOURT_SOURCE_FIELDS = {
  id: { disposition: "stored", target: { type: "identity" } },
  signature: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  date: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  publicationDate: {
    disposition: "stored",
    target: { type: "metadata", key: "publicationDate" },
  },
  lastUpdate: {
    disposition: "stored",
    target: { type: "metadata", key: "lastUpdate" },
  },
  courtId: {
    disposition: "stored",
    target: { type: "metadata", key: "courtId" },
  },
  departmentId: {
    disposition: "stored",
    target: { type: "metadata", key: "departmentId" },
  },
  type: {
    disposition: "stored",
    target: { type: "metadata", key: "documentTypes" },
  },
  excerpt: excludedSourceField(
    "the opening characters of the document the document part holds whole",
  ),
  chairman: JUDGES_FIELD,
  judges: JUDGES_FIELD,
  themePhrases: {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
  references: {
    disposition: "stored",
    target: { type: "metadata", key: "references" },
  },
  legalBases: {
    disposition: "stored",
    target: { type: "metadata", key: "legalBases" },
  },
  recorder: {
    disposition: "stored",
    target: { type: "metadata", key: "recorder" },
  },
  decision: {
    disposition: "stored",
    target: { type: "metadata", key: "decision" },
  },
  reviser: {
    disposition: "stored",
    target: { type: "metadata", key: "reviser" },
  },
  publisher: {
    disposition: "stored",
    target: { type: "metadata", key: "publisher" },
  },
  dateOfPublication: {
    disposition: "stored",
    target: { type: "metadata", key: "dateOfPublication" },
  },
  dateOfLastUpdate: {
    disposition: "stored",
    target: { type: "metadata", key: "dateOfLastUpdate" },
  },
  thesis: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  xPart: { disposition: "stored", target: { type: "document" } },
  "xPart/xName": {
    disposition: "stored",
    target: { type: "metadata", key: "documentTitle" },
  },
  "xPart@xVersion": DOCUMENT_FIELD,
  "xPart@xLang": DOCUMENT_FIELD,
  "xPart@xYear": DOCUMENT_FIELD,
  "xPart@xDocType": DOCUMENT_FIELD,
  "xPart@xVolType": DOCUMENT_FIELD,
  "xPart@xVolNmbr": DOCUMENT_FIELD,
  "xPart@xFromPg": DOCUMENT_FIELD,
  "xPart@xToPage": DOCUMENT_FIELD,
  "xPart@xFlag": DOCUMENT_FIELD,
  "xPart@xEditor": DOCUMENT_FIELD,
  "xPart@xEditorFullName": DOCUMENT_FIELD,
  "xPart@xPublisher": DOCUMENT_FIELD,
  "xPart@xPublisherFullName": DOCUMENT_FIELD,
  "xPart@xClassifier": DOCUMENT_FIELD,
  "xPart@xClassifierFullName": DOCUMENT_FIELD,
  "xPart@xClassified": DOCUMENT_FIELD,
  "xPart@xml:space": excludedSourceField(
    "a serialisation directive for the XML, not a statement about the judgment",
  ),
} as const satisfies Record<PlNcourtSourceField, SourceFieldDisposition>;

/** The names a stored document states: its root, its name, its attributes. */
const contentFieldNames = (content: PlNcourtContent): string[] => [
  "xPart",
  ...(content.title === undefined ? [] : ["xPart/xName"]),
  ...Object.keys(content.attributes).map(
    (name) => `${CONTENT_ATTRIBUTE_PREFIX}${name}`,
  ),
];

const listPlNcourtSourceFields = (parts: SourceRawParts): readonly string[] => {
  const names = new Set<string>();
  const row = readPlNcourtListingRow(parts[RAW_PART.LISTING] ?? "");
  for (const key of Object.keys(row ?? {})) {
    names.add(key);
  }
  const detail = readPlNcourtDetail(parts[RAW_PART.DETAIL] ?? "");
  if (detail?.type === "record") {
    for (const key of [...detail.fields.keys(), ...detail.lists.keys()]) {
      names.add(key);
    }
  }
  const content = readPlNcourtContent(parts[RAW_PART.DOCUMENT] ?? "");
  if (content !== null) {
    for (const name of contentFieldNames(content)) {
      names.add(name);
    }
  }
  return [...names];
};

const SOURCE_SURFACES = [
  "listing",
  "detail",
  "document",
  "document-html",
  "court-dictionary",
  "portal",
] as const;

const PL_NCOURT_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    document: storedSourceSurface(RAW_PART.DOCUMENT),
    "document-html": excludedSourceSurface(
      "the same document rendered as HTML, without the root and statute-link attributes the XML part keeps",
    ),
    "court-dictionary": excludedSourceSurface(
      "reference data naming the courts behind their ids, carried in pl-ncourt-courts.ts rather than per judgment",
    ),
    portal: excludedSourceSurface(
      "the portal's pages drawing the same record and document for a browser",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Normalization ────────────────────────────────────────

/**
 * The components the API lists in `type` ("SENTENCE, REASON") and the
 * stored term of each that names a ruling.
 */
const RULING_COMPONENTS = {
  SENTENCE: "wyrok",
  DECISION: "postanowienie",
  RESOLUTION: "uchwała",
  REGULATION: "zarządzenie",
} as const;

/** The written reasons, published with the ruling or on their own. */
const REASONS_COMPONENT = "REASON";

const REASONS_DECISION_TYPE = "uzasadnienie";

/** Components that name no ruling: the hearing record and anything else. */
const OTHER_COMPONENTS = ["RECORD", "OTHER"] as const;

const isRulingComponent = (
  value: string,
): value is keyof typeof RULING_COMPONENTS =>
  Object.hasOwn(RULING_COMPONENTS, value);

const isKnownComponent = (value: string): boolean =>
  isRulingComponent(value) ||
  value === REASONS_COMPONENT ||
  OTHER_COMPONENTS.some((component) => component === value);

/** The rulings, in the order one names a document holding several. */
const RULING_PRECEDENCE = [
  "SENTENCE",
  "DECISION",
  "RESOLUTION",
  "REGULATION",
] as const satisfies readonly (keyof typeof RULING_COMPONENTS)[];

/** `SENTENCE, REASON` as `["SENTENCE", "REASON"]`. */
export const plNcourtComponents = (type: string | undefined): string[] =>
  (type ?? "")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);

/**
 * The decision type a document is stored under.
 *
 * One document often holds a ruling and its reasons, and some an order of
 * the presiding judge too. The type is the weightiest ruling it holds
 * (a judgment over an order over a presiding judge's order), and the reasons
 * only where the document holds nothing else. SAOS reads the same list the
 * same way: 94 judgments present in both, each type combination observed,
 * carry the type this function gives.
 */
export const plNcourtDecisionType = (
  components: readonly string[],
): string | undefined => {
  const ruling = RULING_PRECEDENCE.find((component) =>
    components.includes(component),
  );
  if (ruling !== undefined) {
    return RULING_COMPONENTS[ruling];
  }
  return components.includes(REASONS_COMPONENT)
    ? REASONS_DECISION_TYPE
    : undefined;
};

/** Where a signature's parts differ only in spacing, one spelling. */
const normalizeSignature = (signature: string): string =>
  collapse(signature).toLocaleUpperCase("pl-PL");

/** What a ruling key is read from: stored columns only. */
type CommonCourtRulingKeyInput = Pick<
  IngestionResult,
  "caseNumber" | "court" | "decisionDate" | "decisionType"
>;

/**
 * The key under which a stored common-court judgment meets its copy in the
 * other source: court, signature, judgment date and decision type.
 *
 * Both this adapter and `pl-courts` store the same judgment under their own
 * ids; the one here is also the `source.judgmentId` SAOS keeps. Two rows
 * sharing a key are one judgment, and this API is the one SAOS imports from.
 * Empty for a row missing the date or the type: a signature alone does not
 * name a judgment, since a ruling and a later order share it.
 */
export const plCommonCourtRulingKeys = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
}: CommonCourtRulingKeyInput): string[] =>
  decisionDate === undefined || decisionType === undefined
    ? []
    : [
        [
          collapse(court).toLocaleLowerCase("pl-PL"),
          normalizeSignature(caseNumber),
          decisionDate,
          decisionType.toLocaleLowerCase("pl-PL"),
        ].join("|"),
      ];

const COURT_ID = /^15\d{6}$/u;

type CourtName = { name: string; known: boolean };

/**
 * The deciding court, from the court id the record states. An id the index
 * does not name is stored as the id itself and reported: the record's own
 * value, never a name guessed from its shape.
 */
const courtNameOf = (courtId: string | undefined): CourtName | undefined => {
  if (courtId === undefined || !COURT_ID.test(courtId)) {
    return undefined;
  }
  const name = PL_NCOURT_COURT_NAMES[courtId];
  if (name !== undefined) {
    return { name, known: true };
  }
  logger.warn("case_law.ingestion.court_unmapped", {
    adapterKey: ADAPTER_KEYS.PL_NCOURT,
    courtId,
  });
  return { name: courtId, known: false };
};

const apiUrl = (path: string, params: Record<string, string>): string =>
  `${ORIGIN}${API_PATH}${path}?${new URLSearchParams(params).toString()}`;

const contentUrlOf = (id: string): string =>
  apiUrl("/judgement/content", { id });

/** The judgment's page on the portal. */
const portalUrlOf = (id: string): string =>
  `${PORTAL_ORIGIN}/details/$N/${encodeURIComponent(id)}`;

/**
 * Who sat, in the roles the record names them in. The chairman is also in
 * the bench list; a chairman the list leaves out is still named.
 */
const benchOf = (
  chairman: string | undefined,
  judges: readonly string[],
): DecisionJudgeInput[] => {
  const members: DecisionJudgeInput[] = judges.map((name) => ({
    role:
      name === chairman
        ? DECISION_JUDGE_ROLE.PRESIDING
        : DECISION_JUDGE_ROLE.PANEL_MEMBER,
    nameAsPrinted: name,
  }));
  return chairman === undefined || judges.includes(chairman)
    ? members
    : [
        { role: DECISION_JUDGE_ROLE.PRESIDING, nameAsPrinted: chairman },
        ...members,
      ];
};

export type PlNcourtBuild =
  | { type: "built"; decision: IngestionResult }
  /** Written reasons published on their own: a supplement of their ruling. */
  | { type: "supplement"; supplement: DecisionSupplement }
  | { type: "unkeyable" };

/** Why a stored row holds less than a record and a document. */
const DETAIL_STATUS = {
  /** The record answered "not found": withdrawn since it was listed. */
  NOT_FOUND: "publisher-not-found",
  /** The listing itself could not serve the row; see its quarantine. */
  LISTING_UNSERVABLE: "listing-unservable",
  /** The listed row states no id the identity column can hold. */
  ID_UNAVAILABLE: "publisher-id-unavailable",
  /** The listed row states an id but no readable signature or court. */
  LISTING_INCOMPLETE: "listing-metadata-incomplete",
} as const;

/** The document endpoint answered 404 for a record it served. */
const DOCUMENT_NOT_FOUND = "404";

type AssemblePlNcourtDecisionOptions = {
  /** The listed `<judgement>` element, verbatim. */
  listingXml: string;
  /** The record verbatim, where one was served. */
  detailXml: string | undefined;
  /** The document verbatim, where one was served. */
  contentXml: string | undefined;
  /** Set where the document endpoint answered 404 for the record. */
  documentStatus?: typeof DOCUMENT_NOT_FOUND | undefined;
  /** The identity of this row's position in the lane that listed it. */
  positionAlias?: string | undefined;
};

const fieldOf = (
  detail: PlNcourtDetail | null,
  name: string,
): string | undefined =>
  detail?.type === "record" ? presentText(detail.fields.get(name)) : undefined;

const listOf = (
  detail: PlNcourtDetail | null,
  name: DetailListField,
): string[] =>
  detail?.type === "record" ? arrayOrEmpty(detail.lists.get(name)) : [];

const orUndefined = <T>(items: readonly T[]): readonly T[] | undefined =>
  items.length === 0 ? undefined : items;

/** The components a type lists and the decision type they name, reported when unknown. */
const typeOf = (
  rawType: string | undefined,
): { components: string[]; decisionType: string | undefined } => {
  const components = plNcourtComponents(rawType);
  const decisionType = plNcourtDecisionType(components);
  if (
    components.some((component) => !isKnownComponent(component)) ||
    (rawType !== undefined && decisionType === undefined)
  ) {
    logger.warn("case_law.ingestion.decision_type_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_NCOURT,
      decisionForm: rawType ?? "",
    });
  }
  return { components, decisionType };
};

/**
 * Every element and attribute the three responses state that nothing here
 * names, verbatim, each reported: a field the API adds is kept on the row
 * and fails the inventory rather than vanishing.
 */
const unmappedFieldsOf = ({
  content,
  detail,
  listing,
}: {
  content: PlNcourtContent | null;
  detail: PlNcourtDetail | null;
  listing: Record<string, unknown>;
}): Record<string, string> => {
  const unmapped: Record<string, string> = Object.fromEntries(
    unmappedListingFields(listing),
  );
  if (detail?.type === "record") {
    for (const [name, value] of detail.fields) {
      if (!isSourceField(name)) {
        unmapped[name] = value;
      }
    }
  }
  if (content !== null) {
    for (const name of contentFieldNames(content)) {
      if (!isSourceField(name)) {
        unmapped[name] =
          content.attributes[name.slice(CONTENT_ATTRIBUTE_PREFIX.length)] ?? "";
      }
    }
  }
  for (const name of Object.keys(unmapped)) {
    logger.warn("case_law.ingestion.source_field_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_NCOURT,
      field: name,
    });
  }
  for (const name of arrayOrEmpty(content?.unmappedMarkup)) {
    logger.warn("case_law.ingestion.markup_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_NCOURT,
      element: name,
    });
  }
  return unmapped;
};

type ParsedDocument = ReturnType<typeof parsePlDecisionContent>;

/** The document parsed as a Polish decision, or `null` where there is none. */
const parseDocument = ({
  content,
  id,
  keyed,
  keywords,
  statutes,
}: {
  content: PlNcourtContent | null;
  id: string;
  keyed: CommonCourtRulingKeyInput;
  keywords: string[];
  statutes: string[];
}): ParsedDocument | null => {
  if (content === null || content.html.length === 0) {
    return null;
  }
  const parsed = Result.try({
    try: () =>
      parsePlDecisionContent({
        caseNumber: keyed.caseNumber,
        ecli: undefined,
        court: keyed.court,
        decisionDate: keyed.decisionDate,
        decisionType: keyed.decisionType,
        sourceUrl: portalUrlOf(id),
        documentUrl: contentUrlOf(id),
        content: content.html,
        keywords,
        statutes,
        documentId: id,
        sourceSystem: PL_NCOURT_SOURCE_SYSTEM,
      }),
    catch: errorTag,
  });
  if (Result.isError(parsed)) {
    logger.warn("case_law.ingestion.document_parse_failed", {
      adapterKey: ADAPTER_KEYS.PL_NCOURT,
      caseNumber: keyed.caseNumber,
      "error.type": parsed.error,
    });
    return null;
  }
  return parsed.value;
};

/** What the record states beyond the keyed columns, for the row's metadata. */
const recordMetadataOf = (
  detail: PlNcourtDetail | null,
  row: PlNcourtListingRow,
): Record<string, unknown> => ({
  departmentId: fieldOf(detail, "departmentId") ?? row.departmentId,
  publicationDate: fieldOf(detail, "publicationDate") ?? row.publicationDate,
  lastUpdate: row.lastUpdate,
  chairman: fieldOf(detail, "chairman"),
  keywords: orUndefined(listOf(detail, "themePhrases")),
  references: orUndefined(listOf(detail, "references")),
  legalBases: orUndefined(listOf(detail, "legalBases")),
  recorder: fieldOf(detail, "recorder"),
  decision: fieldOf(detail, "decision"),
  reviser: fieldOf(detail, "reviser"),
  publisher: fieldOf(detail, "publisher"),
  dateOfPublication: fieldOf(detail, "dateOfPublication"),
  dateOfLastUpdate: fieldOf(detail, "dateOfLastUpdate"),
});

/** What the document states beyond its text, for the row's metadata. */
const documentMetadataOf = (
  content: PlNcourtContent | null,
): Record<string, unknown> =>
  content === null
    ? {}
    : {
        legalReferences: orUndefined(content.legalReferences),
        documentTitle: content.title,
        document:
          Object.keys(content.attributes).length === 0
            ? undefined
            : content.attributes,
        ...(content.unmappedMarkup.length === 0
          ? {}
          : { unmappedMarkup: content.unmappedMarkup }),
      };

/**
 * Build one judgment from the responses in hand. No I/O: the crawl, the
 * reconciliation and a replay of the stored envelope all reach this with the
 * same three payloads.
 */
export const assemblePlNcourtDecision = ({
  contentXml,
  detailXml,
  documentStatus,
  listingXml,
  positionAlias,
}: AssemblePlNcourtDecisionOptions): PlNcourtBuild => {
  const listing = readPlNcourtListingRow(listingXml);
  if (listing === null) {
    return { type: "unkeyable" };
  }
  const row = normalizePlNcourtListingRow(listing);
  const { id } = row;
  const unkeyed = (): PlNcourtBuild => {
    const decision = buildUnkeyedRow({ detailXml, listingXml, row });
    return decision === null
      ? { type: "unkeyable" }
      : { type: "built", decision };
  };
  if (id === undefined || !isPersistableSourceDocumentId(id)) {
    return unkeyed();
  }
  const detail = detailXml === undefined ? null : readPlNcourtDetail(detailXml);
  const record = detail?.type === "record" ? detail : null;

  const caseNumber = fieldOf(detail, "signature") ?? presentText(row.signature);
  const courtId = fieldOf(detail, "courtId") ?? presentText(row.courtId);
  const court = courtNameOf(courtId);
  if (caseNumber === undefined || court === undefined) {
    return unkeyed();
  }

  const { components, decisionType } = typeOf(
    fieldOf(detail, "type") ?? presentText(row.type),
  );
  // Written reasons listed on their own are the reasons of a ruling, joined
  // to it as SAOS's are; while no ruling holds them, their row carries the
  // type SAOS gives such a row, so the two sources key it alike.
  const standaloneReasons = decisionType === REASONS_DECISION_TYPE;
  const decisionDate = plNcourtDay(fieldOf(detail, "date") ?? row.date);
  const keyed: CommonCourtRulingKeyInput = {
    caseNumber,
    court: court.name,
    decisionDate,
    decisionType: standaloneReasons
      ? PL_COURTS_STANDALONE_REASONS_DECISION_TYPE
      : decisionType,
  };

  const content =
    record === null || contentXml === undefined
      ? null
      : readPlNcourtContent(contentXml);
  const unmapped = unmappedFieldsOf({ content, detail, listing });
  const document = parseDocument({
    content,
    id,
    // Titled by what the document is, not by the row that holds it.
    keyed: { ...keyed, decisionType },
    keywords: listOf(detail, "themePhrases"),
    statutes: listOf(detail, "legalBases"),
  });
  const documentAst: DocumentAst | EmptyAst =
    document?.documentAst ?? EMPTY_AST;
  if (content !== null && document !== null) {
    validatePlNcourtDocument(
      {
        parser: ADAPTER_KEYS.PL_NCOURT,
        caseNumber,
        language: PL_NCOURT_LANGUAGE,
        url: contentUrlOf(id),
      },
      content,
      document.documentAst.blocks,
    );
  }

  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.LISTING]: listingXml,
    ...(detailXml === undefined ? {} : { [RAW_PART.DETAIL]: detailXml }),
    ...(contentXml === undefined ? {} : { [RAW_PART.DOCUMENT]: contentXml }),
    ...(documentStatus === undefined
      ? {}
      : { [RAW_PART.DOCUMENT_STATUS]: documentStatus }),
  });
  // Where the listing once could not serve this row, or served it without a
  // usable id, its audit row is found through these, and enriched.
  const repairAliases = [positionAlias, plNcourtRowFingerprintId(row)].filter(
    (alias) => alias !== undefined,
  );

  const decision: IngestionResult = {
    ...keyed,
    sourceDocumentId: id,
    ...(repairAliases.length === 0
      ? {}
      : { sourceDocumentIdRepairAliases: repairAliases }),
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_NCOURT].country,
    language: PL_NCOURT_LANGUAGE,
    fulltext: document?.fulltext,
    // A row whose record is gone keeps its identity and its listed fields,
    // unpublished, for the repair to ask again. A record without a document
    // is not marked here: the write that stores no document decides that.
    ...(record === null ? { isListingOnly: true } : {}),
    ...(record === null
      ? {}
      : {
          judges: benchOf(
            fieldOf(record, "chairman"),
            listOf(record, "judges"),
          ),
        }),
    sourceUrl: portalUrlOf(id),
    documentUrl: contentUrlOf(id),
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      headnote: sourceTextField(
        ADAPTER_KEYS.PL_NCOURT,
        fieldOf(detail, "thesis") ?? presentText(row.thesis),
      ),
    },
    metadata: checkedDecisionMetadata({
      ...keyed,
      courtKnown: court.known,
      documentId: id,
      documentTypes: orUndefined(components),
      courtId,
      ...recordMetadataOf(detail, row),
      ...documentMetadataOf(content),
      rulingKeys: plCommonCourtRulingKeys(keyed),
      detailStatus:
        detail?.type === "not-found" ? DETAIL_STATUS.NOT_FOUND : undefined,
      documentStatus:
        documentStatus === DOCUMENT_NOT_FOUND ? "publisher-404" : undefined,
      ...(Object.keys(unmapped).length === 0
        ? {}
        : { unmappedFields: unmapped }),
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_NCOURT],
    documentAst,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return standaloneReasons
    ? {
        type: "supplement",
        supplement: {
          kind: DECISION_SUPPLEMENT_KIND.REASONS,
          target: {
            decisionTypes: PL_COURTS_RULING_DECISION_TYPES,
            latestDecisionDate: decisionDate,
          },
          document: { ...decision, sourceDocumentId: id },
        },
      }
    : { type: "built", decision };
};

// ── Quarantine ───────────────────────────────────────────

/**
 * A row the listing counted and could not serve: every window holding it
 * answers 404, so it states no id, no signature, nothing of its own. What is
 * known is where it sits in one frozen listing — its filters and order — and
 * which servable rows are nearest on either side, and how far away.
 */
export type PlNcourtQuarantine = {
  /** The listing's filters and order, without the window: its scope. */
  query: Record<string, string>;
  /** Where it sat when it was isolated; history, not identity. */
  offset: number;
  /** The status every window holding it answered. */
  status: number;
  /** The nearest servable rows either side, verbatim, and how many rows off. */
  previous: { xml: string; gap: number } | undefined;
  next: { xml: string; gap: number } | undefined;
};

/** The nearest servable row one side of a position, by id and distance. */
type PositionNeighbour = { id: string | undefined; gap: number };

export type PlNcourtPosition = {
  query: Record<string, string>;
  previous: PositionNeighbour | undefined;
  next: PositionNeighbour | undefined;
};

const QUARANTINE_ID_PREFIX = "ncourt-quarantine:";

/** Rows probed either side of an unservable one for a servable neighbour. */
const QUARANTINE_REACH = 5;

/** A scope's filters in one spelling, whatever order they were built in. */
const scopeOf = (query: Record<string, string>): [string, string][] =>
  // Parameter names are ASCII keys, not words: code-unit order is the order.
  Object.entries(query).toSorted(
    ([left], [right]) => Number(left > right) - Number(left < right),
  );

/**
 * The audit identity of an unservable row: its scope, and the nearest
 * servable rows either side with their distance. The distance keeps a run of
 * unservable rows apart; the scope is a frozen listing, so walking it again
 * finds the same rows at the same distances. Every served row emits the
 * identity of its own position, at distance one each side, as a repair
 * alias, so a row that becomes servable in the same scope lands on its
 * audit row.
 */
export const plNcourtPositionId = ({
  next,
  previous,
  query,
}: PlNcourtPosition): string =>
  `${QUARANTINE_ID_PREFIX}${hashContent(
    JSON.stringify({
      scope: scopeOf(query),
      previous: previous ?? null,
      next: next ?? null,
    }),
  )}`;

const LISTED_ID_PREFIX = "ncourt-listed:";

/**
 * What a listed row states about the judgment, without its id: the fields
 * that stay put when a malformed or missing id is corrected.
 */
const ROW_FINGERPRINT_FIELDS = [
  "signature",
  "date",
  "courtId",
  "departmentId",
  "type",
  "excerpt",
] as const satisfies readonly (keyof PlNcourtListingRow)[];

/**
 * The content-addressed identity of a listed row that states no usable id,
 * or `undefined` for a row stating none of the fields. Every listed row
 * emits its own as a repair alias, so a row whose id is later corrected
 * enriches its audit row instead of doubling it.
 */
export const plNcourtRowFingerprintId = (
  row: PlNcourtListingRow,
): string | undefined => {
  const stated = ROW_FINGERPRINT_FIELDS.flatMap((field) => {
    const value = row[field];
    return value === undefined ? [] : [[field, value] as const];
  });
  return stated.length === 0
    ? undefined
    : `${LISTED_ID_PREFIX}${hashContent(JSON.stringify(stated))}`;
};

/**
 * An unpublished row naming no decision. The court it records is this
 * label because no record exists to read one from; the row is audit, and a
 * later observation of the judgment replaces it through the repair alias.
 */
const UNSERVED_ROW_LABEL = "ncourt-api";

const idOfFragment = (xml: string | undefined): string | undefined =>
  xml === undefined
    ? undefined
    : normalizePlNcourtListingRow(readPlNcourtListingRow(xml) ?? {}).id;

const positionOf = (quarantine: PlNcourtQuarantine): PlNcourtPosition => ({
  query: quarantine.query,
  previous:
    quarantine.previous === undefined
      ? undefined
      : {
          id: idOfFragment(quarantine.previous.xml),
          gap: quarantine.previous.gap,
        },
  next:
    quarantine.next === undefined
      ? undefined
      : { id: idOfFragment(quarantine.next.xml), gap: quarantine.next.gap },
});

/** The durable audit row for a row the listing could not serve. */
export const buildPlNcourtQuarantine = (
  quarantine: PlNcourtQuarantine,
): IngestionResult => {
  const position = positionOf(quarantine);
  const id = plNcourtPositionId(position);
  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.QUARANTINE]: JSON.stringify(quarantine),
  });
  const court = UNSERVED_ROW_LABEL;
  return {
    sourceDocumentId: id,
    caseNumber: id,
    caseNumberIsPlaceholder: true,
    isListingOnly: true,
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_NCOURT].country,
    language: PL_NCOURT_LANGUAGE,
    sourceUrl: apiUrl("/judgements", {
      ...quarantine.query,
      offset: String(quarantine.offset),
      limit: "1",
    }),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      detailStatus: DETAIL_STATUS.LISTING_UNSERVABLE,
      quarantine: {
        query: quarantine.query,
        offset: quarantine.offset,
        status: quarantine.status,
        previous: position.previous,
        next: position.next,
      },
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_NCOURT],
    documentAst: EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

/**
 * The durable row for a listed row that cannot be keyed as a judgment: one
 * whose id is missing or too long for the identity column (kept under its
 * content fingerprint), or one whose signature or court cannot be read
 * (kept under its id). Unpublished; the listed bytes are its raw.
 */
const buildUnkeyedRow = ({
  detailXml,
  listingXml,
  row,
}: {
  detailXml: string | undefined;
  listingXml: string;
  row: PlNcourtListingRow;
}): IngestionResult | null => {
  const idUsable =
    row.id !== undefined && isPersistableSourceDocumentId(row.id);
  const sourceDocumentId = idUsable ? row.id : plNcourtRowFingerprintId(row);
  if (sourceDocumentId === undefined) {
    return null;
  }
  const signature = presentText(row.signature);
  const court = courtNameOf(presentText(row.courtId))?.name;
  const label = UNSERVED_ROW_LABEL;
  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.LISTING]: listingXml,
    ...(detailXml === undefined ? {} : { [RAW_PART.DETAIL]: detailXml }),
  });
  return {
    sourceDocumentId,
    caseNumber: signature ?? sourceDocumentId,
    ...(signature === undefined ? { caseNumberIsPlaceholder: true } : {}),
    isListingOnly: true,
    court: court ?? label,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_NCOURT].country,
    language: PL_NCOURT_LANGUAGE,
    decisionDate: plNcourtDay(row.date),
    ...(idUsable && row.id !== undefined
      ? { sourceUrl: portalUrlOf(row.id) }
      : {}),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: checkedDecisionMetadata({
      detailStatus: idUsable
        ? DETAIL_STATUS.LISTING_INCOMPLETE
        : DETAIL_STATUS.ID_UNAVAILABLE,
      listed: row,
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_NCOURT],
    documentAst: EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

const isGapped = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    typeof value["xml"] === "string" &&
    typeof value["gap"] === "number");

const isQuarantine = (value: unknown): value is PlNcourtQuarantine =>
  isRecord(value) &&
  isRecord(value["query"]) &&
  typeof value["offset"] === "number" &&
  typeof value["status"] === "number" &&
  isGapped(value["previous"]) &&
  isGapped(value["next"]);

// ── Requests ─────────────────────────────────────────────

const publisherError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `ncourt-api: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_NCOURT,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

type Answered = { status: number; body: string; url: string; xml: boolean };

/**
 * The most one response may hold. A full listing window is a few hundred
 * kilobytes and the longest documents a few megabytes; an answer past this
 * is not one the API gives, and is refused rather than cut.
 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const XML_MEDIA_TYPES = new Set(["text/xml", "application/xml"]);

const mediaTypeOf = (contentType: string | null): string =>
  (contentType?.split(";").at(0) ?? "").trim().toLowerCase();

/**
 * One gated request. Timeouts and 5xx are retried by the gate's fetch and
 * then answered here as they came; a 429 is never retried. Every status is
 * the caller's to classify.
 */
const request = async ({
  cursor,
  params,
  path,
  signal,
  timeoutMs,
}: {
  cursor: string;
  params: Record<string, string>;
  path: string;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}): Promise<Result<Answered, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_NCOURT_HOST_POLICY,
    rawUrl: apiUrl(path, params),
  });
  if (target === null) {
    return panic(`ncourt-api request escaped the publisher origin: ${cursor}`);
  }
  const response = await fetchWithRetry(
    target.toString(),
    { headers: { Accept: "text/xml" }, redirect: "error" },
    { adapterKey: ADAPTER_KEYS.PL_NCOURT, signal, timeoutMs },
  );
  const bytes =
    response.body === null
      ? new Uint8Array()
      : await readCappedBytes(response.body, MAX_RESPONSE_BYTES);
  if (bytes === null) {
    return Result.err(
      publisherError(
        cursor,
        `answered more than ${MAX_RESPONSE_BYTES} bytes`,
        response.status,
      ),
    );
  }
  return Result.ok({
    status: response.status,
    body: new TextDecoder().decode(bytes),
    url: target.toString(),
    xml: XML_MEDIA_TYPES.has(mediaTypeOf(response.headers.get("content-type"))),
  });
};

/**
 * Refuse anything that is not the API speaking XML. A page in front of the
 * API answering for it (a challenge, a maintenance page), a server error, a
 * rate-limit refusal: each fails the page so its cursor is asked again, and
 * none is worked around.
 */
const notXml = (cursor: string, answered: Answered): AdapterFetchError =>
  publisherError(
    cursor,
    `answered ${answered.status} with a body that is not the API's XML`,
    answered.status,
  );

type Listed =
  | { type: "listed"; listing: PlNcourtListing; url: string }
  /** The whole window answered 404: it holds a record the API cannot serve. */
  | { type: "unreadable-window"; url: string };

/**
 * One listing window. A window that holds fewer rows than it asked for while
 * the count says more lie past its start is not the end of the listing: it
 * is refused, never read as one.
 */
const listWindow = async ({
  cursor,
  params,
  signal,
  timeoutMs = ADAPTER_TIMEOUT.PAGE * 4,
}: {
  cursor: string;
  params: Record<string, string>;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}): Promise<Result<Listed, AdapterFetchError>> => {
  const requested = await request({
    cursor,
    params,
    path: "/judgements",
    signal,
    timeoutMs,
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const answered = requested.value;
  if (answered.status === 404) {
    return Result.ok({ type: "unreadable-window", url: answered.url });
  }
  const listing =
    answered.status === 200 && answered.xml
      ? readPlNcourtListing(answered.body)
      : null;
  if (listing === null) {
    return Result.err(notXml(cursor, answered));
  }
  const offset = Number(params["offset"] ?? "0");
  const limit = Number(params["limit"] ?? "0");
  const listed = listing.rows.length;
  if (limit > 0 && listed < limit && offset + listed < listing.total) {
    return Result.err(
      publisherError(
        cursor,
        `listed ${listed} rows at offset ${offset} of a count of ${listing.total}`,
      ),
    );
  }
  return Result.ok({ type: "listed", listing, url: answered.url });
};

/** Detail statuses that say the record is gone, not that the request failed. */
const GONE_STATUSES = new Set([404, 410]);

/**
 * What asking about one listed judgment produced. A refused, failed or
 * unreadable request is the page's failure, retried with its cursor; only
 * the API's own "not found" is a record that is gone, and a document 404 a
 * record with no document. Both are stored.
 */
const fetchPlNcourtDecision = async ({
  cursor,
  listingXml,
  positionAlias,
  signal,
}: {
  cursor: string;
  listingXml: string;
  positionAlias?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<Result<PlNcourtBuild, AdapterFetchError>> => {
  const { id } = normalizePlNcourtListingRow(
    readPlNcourtListingRow(listingXml) ?? {},
  );
  if (id === undefined || !isPersistableSourceDocumentId(id)) {
    // Nothing to ask the record for: the row is kept as the listing states it.
    return Result.ok(
      assemblePlNcourtDecision({
        listingXml,
        detailXml: undefined,
        contentXml: undefined,
      }),
    );
  }
  const detail = await request({
    cursor,
    params: { id },
    path: "/judgement/details",
    signal,
    timeoutMs: ADAPTER_TIMEOUT.LIST,
  });
  if (Result.isError(detail)) {
    return detail;
  }
  const record =
    detail.value.status === 200 && detail.value.xml
      ? readPlNcourtDetail(detail.value.body)
      : null;
  if (record?.type === "not-found" || GONE_STATUSES.has(detail.value.status)) {
    logger.warn("case_law.ingestion.listed_record_not_found", {
      adapterKey: ADAPTER_KEYS.PL_NCOURT,
      cursor,
      sourceDocumentId: id,
    });
    return Result.ok(
      assemblePlNcourtDecision({
        listingXml,
        // A bare 404 states no record; the stored part says it was asked.
        detailXml:
          record?.type === "not-found"
            ? detail.value.body
            : `<error>${NOT_FOUND_DETAIL}</error>`,
        contentXml: undefined,
        positionAlias,
      }),
    );
  }
  if (record === null) {
    return Result.err(notXml(cursor, detail.value));
  }
  const content = await request({
    cursor,
    params: { id },
    path: "/judgement/content",
    signal,
    timeoutMs: ADAPTER_TIMEOUT.PAGE,
  });
  if (Result.isError(content)) {
    return content;
  }
  if (GONE_STATUSES.has(content.value.status)) {
    return Result.ok(
      assemblePlNcourtDecision({
        listingXml,
        detailXml: detail.value.body,
        contentXml: undefined,
        documentStatus: DOCUMENT_NOT_FOUND,
        positionAlias,
      }),
    );
  }
  if (
    content.value.status !== 200 ||
    !content.value.xml ||
    readPlNcourtContent(content.value.body) === null
  ) {
    return Result.err(notXml(cursor, content.value));
  }
  return Result.ok(
    assemblePlNcourtDecision({
      listingXml,
      detailXml: detail.value.body,
      contentXml: content.value.body,
      positionAlias,
    }),
  );
};

/** The record a bare 404 on the detail endpoint is stored as. */
const NOT_FOUND_DETAIL = "Judgement not found (HTTP 404).";

/**
 * The nearest servable rows either side of an unservable one, each asked
 * for alone, up to a few rows away. A run of unservable rows is told apart
 * by the distances.
 */
const quarantineAt = async ({
  cursor,
  offset,
  query,
  signal,
}: {
  cursor: string;
  offset: number;
  query: Record<string, string>;
  signal?: AbortSignal | undefined;
}): Promise<Result<PlNcourtQuarantine, AdapterFetchError>> => {
  const nearest = async (
    step: -1 | 1,
  ): Promise<
    Result<{ xml: string; gap: number } | undefined, AdapterFetchError>
  > => {
    for (let gap = 1; gap <= QUARANTINE_REACH; gap += 1) {
      const at = offset + step * gap;
      if (at < 0) {
        return Result.ok(undefined);
      }
      const listed = await listWindow({
        cursor,
        params: { ...query, offset: String(at), limit: "1" },
        signal,
      });
      if (Result.isError(listed)) {
        return listed;
      }
      if (listed.value.type === "listed") {
        const xml = listed.value.listing.fragments[0];
        // Past the end of the listing: there is no row on this side.
        return Result.ok(xml === undefined ? undefined : { xml, gap });
      }
    }
    return Result.ok(undefined);
  };
  const previous = await nearest(-1);
  if (Result.isError(previous)) {
    return previous;
  }
  const next = await nearest(1);
  if (Result.isError(next)) {
    return next;
  }
  logger.warn("case_law.ingestion.listing_row_quarantined", {
    adapterKey: ADAPTER_KEYS.PL_NCOURT,
    cursor,
    offset,
  });
  return Result.ok({
    query,
    offset,
    status: 404,
    previous: previous.value,
    next: next.value,
  });
};

// ── Replay ───────────────────────────────────────────────

const rejected = (
  rejection: (typeof STORED_RAW_REPARSE_REJECTION)[keyof typeof STORED_RAW_REPARSE_REJECTION],
  detail: string,
): StoredRawReparseOutcome => ({ type: "rejected", rejection, detail });

const reparsePlNcourtStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (stored.contentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE) {
    return rejected(
      STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      `stored under ${stored.contentType ?? "no content type"}`,
    );
  }
  const parts = decodeSourceRawEnvelope(new TextDecoder().decode(stored.raw));
  const quarantine = Result.try((): unknown =>
    JSON.parse(parts?.[RAW_PART.QUARANTINE] ?? "null"),
  ).unwrapOr(null);
  if (isQuarantine(quarantine)) {
    const decision = buildPlNcourtQuarantine(quarantine);
    return decision.sourceDocumentId === stored.sourceDocumentId
      ? { type: "parsed", result: decision }
      : rejected(
          STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
          `the quarantine names ${decision.sourceDocumentId ?? "no id"}`,
        );
  }
  const listingXml = parts?.[RAW_PART.LISTING];
  const listing =
    listingXml === undefined ? null : readPlNcourtListingRow(listingXml);
  if (listingXml === undefined || listing === null) {
    return rejected(
      STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      "the stored payload holds no listed row",
    );
  }
  const built = assemblePlNcourtDecision({
    listingXml,
    detailXml: parts?.[RAW_PART.DETAIL],
    contentXml: parts?.[RAW_PART.DOCUMENT],
    documentStatus:
      parts?.[RAW_PART.DOCUMENT_STATUS] === DOCUMENT_NOT_FOUND
        ? DOCUMENT_NOT_FOUND
        : undefined,
  });
  const rebuilt =
    built.type === "supplement" ? built.supplement.document : undefined;
  const builtId =
    built.type === "built"
      ? built.decision.sourceDocumentId
      : rebuilt?.sourceDocumentId;
  if (built.type !== "unkeyable" && builtId !== stored.sourceDocumentId) {
    return rejected(
      STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      `the envelope names ${builtId ?? "no id"}, the row ${stored.sourceDocumentId ?? "none"}`,
    );
  }
  switch (built.type) {
    case "built":
      return { type: "parsed", result: built.decision };
    case "supplement":
      return { type: "supplement", supplement: built.supplement };
    case "unkeyable":
      return rejected(
        STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        "the stored payload states no readable row",
      );
    default: {
      built satisfies never;
      return panic(`Unhandled pl-ncourt build: ${JSON.stringify(built)}`);
    }
  }
};

// ── Crawl cursor ─────────────────────────────────────────

/**
 * Both lanes page a frozen set. `publicationDateFrom` is inclusive and
 * `publicationDateTo` exclusive, by publication day (checked against the
 * live API: from = to = one day lists nothing, from = D, to = D + 1 lists
 * exactly day D). A row the publisher adds is published today, so it never
 * enters a set bounded by a day already past; a withdrawal can still shift
 * the set, which the anchor catches.
 *
 * `anchor` is the id of the last row a page read. The next full page asks
 * for one row more, starting one back, and expects the anchor first; any
 * other row there means rows before the offset were withdrawn, and the lane
 * rewinds rather than skip what slid into the range it had passed.
 */
type PlNcourtCursor =
  | {
      lane: "walk";
      /** The day the walk began: it lists what was published before it. */
      since: string;
      offset: number;
      window: number;
      anchor: string;
    }
  | {
      lane: "tip";
      /** The first publication day of the lap, inclusive. */
      from: string;
      /** The day the lap stops before, fixed when the lap starts. */
      to: string;
      offset: number;
      window: number;
      anchor: string;
    };

const DAY = "\\d{4}-\\d{2}-\\d{2}";

/** An id the anchor names: a publisher id, which states no colon. */
const ANCHOR = "[^:]{0,256}";

const WALK_CURSOR = new RegExp(
  `^walk:(?<since>${DAY}):(?<offset>\\d+):(?<window>\\d+):(?<anchor>${ANCHOR})$`,
  "u",
);

const TIP_CURSOR = new RegExp(
  `^tip:(?<from>${DAY}):(?<to>${DAY}):(?<offset>\\d+):(?<window>\\d+):(?<anchor>${ANCHOR})$`,
  "u",
);

const today = (): string => Temporal.Now.plainDateISO("UTC").toString();

const isWindow = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= PL_NCOURT_WINDOW;

const isDay = (value: string | undefined): value is string =>
  value !== undefined && parsePlainDate(value) !== null;

/**
 * A cursor read back, or a fresh walk for anything that is not one. A walk
 * restarted by an unreadable cursor re-reads what it had read; it never
 * skips.
 */
export const parsePlNcourtCursor = (cursor: string | null): PlNcourtCursor => {
  const fresh: PlNcourtCursor = {
    lane: "walk",
    since: today(),
    offset: 0,
    window: PL_NCOURT_WINDOW,
    anchor: "",
  };
  if (cursor === null) {
    return fresh;
  }
  const walk = WALK_CURSOR.exec(cursor)?.groups;
  const tip = TIP_CURSOR.exec(cursor)?.groups;
  const groups = walk ?? tip;
  const offset = Number(groups?.["offset"]);
  const window = Number(groups?.["window"]);
  const anchor = groups?.["anchor"] ?? "";
  if (!Number.isSafeInteger(offset) || !isWindow(window)) {
    return fresh;
  }
  const since = walk?.["since"];
  if (isDay(since)) {
    return { lane: "walk", since, offset, window, anchor };
  }
  const from = tip?.["from"];
  const to = tip?.["to"];
  return isDay(from) && isDay(to)
    ? { lane: "tip", from, to, offset, window, anchor }
    : fresh;
};

export const encodePlNcourtCursor = (cursor: PlNcourtCursor): string =>
  cursor.lane === "walk"
    ? `walk:${cursor.since}:${cursor.offset}:${cursor.window}:${cursor.anchor}`
    : `tip:${cursor.from}:${cursor.to}:${cursor.offset}:${cursor.window}:${cursor.anchor}`;

/** A lane's frozen set: its filters and order, without its window. */
const laneQuery = (cursor: PlNcourtCursor): Record<string, string> =>
  cursor.lane === "walk"
    ? { sort: SORT_BY_SIGNATURE, publicationDateTo: cursor.since }
    : {
        sort: SORT_BY_SIGNATURE,
        publicationDateFrom: cursor.from,
        publicationDateTo: cursor.to,
      };

/** A tip parked on `day`: its lap starts once that day has closed. */
const parkedTip = (day: string): PlNcourtCursor => ({
  lane: "tip",
  from: day,
  to: day,
  offset: 0,
  window: PL_NCOURT_WINDOW,
  anchor: "",
});

/** Rows a lane steps back when the rows before its offset have shifted. */
const PL_NCOURT_REWIND = 200;

/** The rows either side of each listed row, at distance one. */
const positionAliasOf = (
  query: Record<string, string>,
  rows: readonly PlNcourtListingRow[],
  index: number,
): string | undefined => {
  const previousId = rows[index - 1]?.id;
  const nextId = rows[index + 1]?.id;
  return previousId === undefined || nextId === undefined
    ? undefined
    : plNcourtPositionId({
        query,
        previous: { id: previousId, gap: 1 },
        next: { id: nextId, gap: 1 },
      });
};

// ── Crawl ────────────────────────────────────────────────

type Built = {
  decisions: IngestionResult[];
  supplements: DecisionSupplement[];
  read: number;
  aborted: boolean;
};

type PendingRow = { fragment: string; positionAlias: string | undefined };

const buildRows = async (
  rows: readonly PendingRow[],
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<Built, AdapterFetchError>> => {
  const decisions: IngestionResult[] = [];
  const supplements: DecisionSupplement[] = [];
  for (const [index, row] of rows.entries()) {
    if (signal?.aborted) {
      return Result.ok({ decisions, supplements, read: index, aborted: true });
    }
    const attempted = await fetchPlNcourtDecision({
      cursor,
      listingXml: row.fragment,
      positionAlias: row.positionAlias,
      signal,
    });
    if (Result.isError(attempted)) {
      return attempted;
    }
    const built = attempted.value;
    switch (built.type) {
      case "built":
        decisions.push(built.decision);
        break;
      case "supplement":
        supplements.push(built.supplement);
        break;
      case "unkeyable":
        // Only a row the page's own reader could not read back; every row a
        // listing parsed is stored, keyed or quarantined.
        return Result.err(
          publisherError(cursor, "a listed row could not be read back"),
        );
      default: {
        built satisfies never;
        return panic(`Unhandled pl-ncourt build: ${JSON.stringify(built)}`);
      }
    }
  }
  return Result.ok({
    decisions,
    supplements,
    read: rows.length,
    aborted: false,
  });
};

/** Where a lane goes after a window it read the first `read` rows of. */
const afterWindow = ({
  cursor,
  listing,
  read,
}: {
  cursor: PlNcourtCursor;
  listing: PlNcourtListing;
  read: number;
}): PlNcourtCursor => {
  const offset = cursor.offset + read;
  // A narrowed window that read cleanly widens again, doubling.
  const window = Math.min(PL_NCOURT_WINDOW, cursor.window * 2);
  const ended =
    read === listing.rows.length &&
    (listing.rows.length < cursor.window || offset >= listing.total);
  if (ended) {
    // The walk hands over at the day it began; a lap at the day it stopped
    // before. Either way the next lap waits for that day to close.
    return parkedTip(cursor.lane === "walk" ? cursor.since : cursor.to);
  }
  const last = listing.rows[read - 1]?.id;
  const anchor =
    last !== undefined && isPersistableSourceDocumentId(last) ? last : "";
  return { ...cursor, offset, window, anchor };
};

/**
 * Rows outside the lane's publication days mean its filter was not applied,
 * and the rows are not the lane's.
 */
const checkLaneFilter = (
  cursor: PlNcourtCursor,
  listing: PlNcourtListing,
): string | null => {
  const outside = listing.rows.find((row) => {
    const day = plNcourtDay(row.publicationDate);
    if (day === undefined) {
      return false;
    }
    return cursor.lane === "walk"
      ? day >= cursor.since
      : day < cursor.from || day >= cursor.to;
  });
  return outside === undefined
    ? null
    : `${new URLSearchParams(laneQuery(cursor)).toString()} listed a row published ${outside.publicationDate ?? ""}`;
};

/**
 * A window that answered 404 narrows, halving, on the next page. Isolated to
 * one row, the row is quarantined: stored as an audit row under its position
 * in the lane's frozen set, and the lane moves past it.
 */
const fetchUnreadableWindow = async (
  cursor: PlNcourtCursor,
  url: string,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  if (cursor.window > 1) {
    return Result.ok({
      decisions: [],
      sourceUrl: url,
      nextCursor: encodePlNcourtCursor({
        ...cursor,
        window: Math.ceil(cursor.window / 2),
      }),
    });
  }
  const quarantine = await quarantineAt({
    cursor: encodePlNcourtCursor(cursor),
    offset: cursor.offset,
    query: laneQuery(cursor),
    signal,
  });
  if (Result.isError(quarantine)) {
    return quarantine;
  }
  return Result.ok({
    decisions: [buildPlNcourtQuarantine(quarantine.value)],
    sourceUrl: url,
    nextCursor: encodePlNcourtCursor({
      ...cursor,
      offset: cursor.offset + 1,
      window: PL_NCOURT_WINDOW,
      anchor: "",
    }),
  });
};

type Anchored =
  | { type: "window"; listing: PlNcourtListing; url: string; skip: number }
  | { type: "unreadable-window"; url: string }
  | { type: "shifted"; url: string; found: string | undefined };

/**
 * The lane's current window, one row wider at the front where an anchor is
 * held: the row read last must still be the row before the offset. A window
 * holding an unservable row is asked for again without the extra row, so
 * the halving works on the lane's own window.
 */
const listLaneWindow = async (
  cursor: PlNcourtCursor,
  signal?: AbortSignal,
): Promise<Result<Anchored, AdapterFetchError>> => {
  const encoded = encodePlNcourtCursor(cursor);
  const query = laneQuery(cursor);
  const anchored =
    cursor.anchor !== "" &&
    cursor.offset > 0 &&
    cursor.window === PL_NCOURT_WINDOW;
  if (anchored) {
    const listed = await listWindow({
      cursor: encoded,
      params: {
        ...query,
        offset: String(cursor.offset - 1),
        limit: String(cursor.window + 1),
      },
      signal,
    });
    if (Result.isError(listed)) {
      return listed;
    }
    if (listed.value.type === "listed") {
      const found = listed.value.listing.rows[0]?.id;
      return Result.ok(
        found === cursor.anchor
          ? {
              type: "window",
              listing: listed.value.listing,
              url: listed.value.url,
              skip: 1,
            }
          : { type: "shifted", url: listed.value.url, found },
      );
    }
  }
  const listed = await listWindow({
    cursor: encoded,
    params: {
      ...query,
      offset: String(cursor.offset),
      limit: String(cursor.window),
    },
    signal,
  });
  if (Result.isError(listed)) {
    return listed;
  }
  return Result.ok(
    listed.value.type === "listed"
      ? {
          type: "window",
          listing: listed.value.listing,
          url: listed.value.url,
          skip: 0,
        }
      : listed.value,
  );
};

/** The rows a window holds past the anchor it was asked to repeat. */
const withoutAnchor = (
  listing: PlNcourtListing,
  skip: number,
): PlNcourtListing => ({
  total: listing.total,
  fragments: listing.fragments.slice(skip),
  rows: listing.rows.slice(skip),
});

const plNcourtFetchPage = async (
  rawCursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const parsed = parsePlNcourtCursor(rawCursor);
  // A lap starts only over closed days, and stops before today: a cycle on
  // the day the last lap ended costs nothing.
  const lapStart =
    parsed.lane === "tip" && parsed.offset === 0 && parsed.anchor === "";
  if (lapStart && parsed.from >= today()) {
    return Result.ok({
      decisions: [],
      nextCursor: encodePlNcourtCursor(parsed),
    });
  }
  const cursor: PlNcourtCursor = lapStart ? { ...parsed, to: today() } : parsed;
  const encoded = encodePlNcourtCursor(cursor);
  const listed = await listLaneWindow(cursor, signal);
  if (Result.isError(listed)) {
    return listed;
  }
  if (listed.value.type === "unreadable-window") {
    return await fetchUnreadableWindow(cursor, listed.value.url, signal);
  }
  if (listed.value.type === "shifted") {
    logger.warn("case_law.ingestion.listing_shifted", {
      adapterKey: ADAPTER_KEYS.PL_NCOURT,
      cursor: encoded,
      found: listed.value.found ?? "",
    });
    return Result.ok({
      decisions: [],
      sourceUrl: listed.value.url,
      nextCursor: encodePlNcourtCursor({
        ...cursor,
        offset: Math.max(0, cursor.offset - PL_NCOURT_REWIND),
        window: PL_NCOURT_WINDOW,
        anchor: "",
      }),
    });
  }
  const { listing: asked, skip, url } = listed.value;
  const filterDefect = checkLaneFilter(cursor, asked);
  if (filterDefect !== null) {
    return Result.err(publisherError(encoded, filterDefect));
  }
  const query = laneQuery(cursor);
  const listing = withoutAnchor(asked, skip);
  const pending = listing.fragments.map((fragment, index) => ({
    fragment,
    positionAlias: positionAliasOf(query, asked.rows, index + skip),
  }));
  const built = await buildRows(pending, encoded, signal);
  if (Result.isError(built)) {
    return built;
  }
  const { decisions, supplements, read } = built.value;
  return Result.ok({
    decisions,
    ...(supplements.length === 0 ? {} : { supplements }),
    sourceUrl: url,
    nextCursor: encodePlNcourtCursor(afterWindow({ cursor, listing, read })),
  });
};

// ── Reconciliation ───────────────────────────────────────

const plNcourtDaySlices = createCalendarDaySliceWalk({
  firstSlice: PL_NCOURT_FIRST_SLICE,
  source: ADAPTER_KEYS.PL_NCOURT,
});

/** What the reconciliation parks for a listed row, and rebuilds it from. */
type SlicePayload =
  | { listingXml: string; positionAlias?: string | undefined }
  | { quarantine: PlNcourtQuarantine };

const sliceQuery = (slice: string): Record<string, string> => ({
  dateFrom: slice,
  dateTo: slice,
  sort: SORT_BY_SIGNATURE,
});

/** How the ingest keys a listed row: its id, or its content fingerprint. */
const plNcourtListingIdentity = (row: PlNcourtListingRow): ListingIdentity => {
  const sourceDocumentId =
    row.id !== undefined && isPersistableSourceDocumentId(row.id)
      ? row.id
      : plNcourtRowFingerprintId(row);
  return sourceDocumentId === undefined
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId };
};

/**
 * The items of one window of a judgment date. A window that answers 404 is
 * halved until the unservable row is isolated, and that row is listed as its
 * quarantine, so the slice counts it rather than losing it.
 */
const listSliceWindow = async ({
  limit,
  offset,
  signal,
  slice,
}: {
  limit: number;
  offset: number;
  signal?: AbortSignal | undefined;
  slice: string;
}): Promise<
  Result<
    { total: number | undefined; items: ReconciliationListingItem[] },
    AdapterFetchError
  >
> => {
  const query = sliceQuery(slice);
  const listed = await listWindow({
    cursor: slice,
    params: { ...query, offset: String(offset), limit: String(limit) },
    signal,
    timeoutMs: ADAPTER_TIMEOUT.PAGE,
  });
  if (Result.isError(listed)) {
    return listed;
  }
  if (listed.value.type === "listed") {
    const { listing } = listed.value;
    const stray = listing.rows.find((row) => plNcourtDay(row.date) !== slice);
    if (stray !== undefined) {
      return Result.err(
        publisherError(
          slice,
          `dateFrom=${slice} listed a judgment dated ${stray.date ?? "nothing"}`,
        ),
      );
    }
    return Result.ok({
      total: listing.total,
      items: listing.fragments.map((listingXml, index) => {
        const payload: SlicePayload = {
          listingXml,
          positionAlias: positionAliasOf(query, listing.rows, index),
        };
        return {
          identity: plNcourtListingIdentity(
            listing.rows[index] ?? panic("a listed row lost its reading"),
          ),
          payload,
        };
      }),
    });
  }
  if (limit === 1) {
    const quarantine = await quarantineAt({
      cursor: `${slice}:${offset}`,
      offset,
      query,
      signal,
    });
    if (Result.isError(quarantine)) {
      return quarantine;
    }
    const payload: SlicePayload = { quarantine: quarantine.value };
    const { sourceDocumentId } = buildPlNcourtQuarantine(quarantine.value);
    return Result.ok({
      total: undefined,
      items: [
        {
          identity:
            sourceDocumentId === undefined
              ? { type: "unidentifiable" }
              : { type: "document", sourceDocumentId },
          payload,
        },
      ],
    });
  }
  const half = Math.ceil(limit / 2);
  const first = await listSliceWindow({ limit: half, offset, signal, slice });
  if (Result.isError(first)) {
    return first;
  }
  const second = await listSliceWindow({
    limit: limit - half,
    offset: offset + half,
    signal,
    slice,
  });
  if (Result.isError(second)) {
    return second;
  }
  return Result.ok({
    total: first.value.total ?? second.value.total,
    items: [...first.value.items, ...second.value.items],
  });
};

/**
 * One page of the listing for a judgment date. The page count comes from the
 * listing's own count, so a slice ends where the publisher says it does.
 */
const listPlNcourtSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const listed = await listSliceWindow({
    limit: PL_NCOURT_SLICE_ROWS,
    offset: page * PL_NCOURT_SLICE_ROWS,
    signal,
    slice,
  });
  if (Result.isError(listed)) {
    return await Promise.reject(listed.error);
  }
  const { items, total } = listed.value;
  return {
    items,
    // A page every row of which was unservable states no total; it is still
    // a page, and the ones after it are listed.
    totalPages:
      total === undefined ? page + 2 : Math.ceil(total / PL_NCOURT_SLICE_ROWS),
  };
};

const isSlicePayload = (value: unknown): value is SlicePayload =>
  isRecord(value) &&
  (typeof value["listingXml"] === "string" ||
    isQuarantine(value["quarantine"]));

const buildPlNcourtFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isSlicePayload(payload)) {
    return { type: "unkeyable" };
  }
  if ("quarantine" in payload) {
    return {
      type: "built",
      decision: buildPlNcourtQuarantine(payload.quarantine),
    };
  }
  const attempted = await fetchPlNcourtDecision({
    cursor: "reconciliation",
    listingXml: payload.listingXml,
    positionAlias:
      typeof payload.positionAlias === "string"
        ? payload.positionAlias
        : undefined,
    signal,
  });
  if (Result.isError(attempted)) {
    return await Promise.reject(attempted.error);
  }
  // A withdrawn record is built as its listing-only row: the ledger does
  // not count it held, so the repair keeps asking.
  const built = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "supplement":
      return { type: "built-supplement", supplement: built.supplement };
    case "unkeyable":
      return { type: "unkeyable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-ncourt build: ${JSON.stringify(built)}`);
    }
  }
};

// ── Counts ───────────────────────────────────────────────

const readTotal = async ({
  cursor,
  params,
  signal,
}: {
  cursor: string;
  params: Record<string, string>;
  signal?: AbortSignal | undefined;
}): Promise<Result<PlNcourtListing, AdapterFetchError>> => {
  const listed = await listWindow({ cursor, params, signal });
  if (Result.isError(listed)) {
    return listed;
  }
  return listed.value.type === "listed"
    ? Result.ok(listed.value.listing)
    : Result.err(publisherError(cursor, "count request answered 404", 404));
};

/** The whole corpus's count, as the listing states it with no filter. */
const plNcourtTotalCount = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const listed = await Result.tryPromise({
    try: async () =>
      await readTotal({ cursor: "total", params: { limit: "0" }, signal }),
    catch: errorTag,
  });
  if (Result.isError(listed)) {
    return { type: "probe-failed", errorTag: listed.error };
  }
  return Result.isError(listed.value)
    ? sourceTotalProbeFailed(
        listed.value.error.httpStatus === 200
          ? SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD
          : SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS,
      )
    : sourceTotalRead(listed.value.value.total);
};

type PlNcourtCourtCount = { courtId: string; count: number };

/**
 * One court's count, from the listing filtered to it.
 *
 * The listing drops a court id it does not know and answers the whole
 * corpus, so a count is accepted only where the filter visibly took: the
 * count is below the unfiltered total, and the row it lists is that court's.
 */
export const plNcourtCourtCount = async ({
  courtId,
  signal,
  unfilteredTotal,
}: {
  courtId: string;
  signal?: AbortSignal | undefined;
  unfilteredTotal: number;
}): Promise<Result<PlNcourtCourtCount, AdapterFetchError>> => {
  const listed = await readTotal({
    cursor: courtId,
    params: { court: courtId, limit: "1", sort: SORT_BY_SIGNATURE },
    signal,
  });
  if (Result.isError(listed)) {
    return listed;
  }
  const { rows, total } = listed.value;
  const [row] = rows;
  if (
    total >= unfilteredTotal ||
    (row !== undefined && row.courtId !== courtId)
  ) {
    return Result.err(
      publisherError(
        courtId,
        `court=${courtId} was not applied: it counted ${total} of ${unfilteredTotal}${row === undefined ? "" : ` and listed court ${row.courtId ?? "none"}`}`,
      ),
    );
  }
  return Result.ok({ courtId, count: total });
};

type PlNcourtCensus = {
  /** `total` of the unfiltered listing. */
  total: number;
  /** Each known court's own count. */
  courts: PlNcourtCourtCount[];
  /** What the per-court counts leave of the total: courts not in the index. */
  unattributed: number;
};

/**
 * Every known court's count beside the corpus total, one request a court.
 * What the courts do not add up to is stated, never spread over them.
 */
export const plNcourtCensus = async (
  signal?: AbortSignal,
): Promise<Result<PlNcourtCensus, AdapterFetchError>> => {
  const unfiltered = await readTotal({
    cursor: "census",
    params: { limit: "0" },
    signal,
  });
  if (Result.isError(unfiltered)) {
    return unfiltered;
  }
  const { total } = unfiltered.value;
  const courts: PlNcourtCourtCount[] = [];
  for (const courtId of Object.keys(PL_NCOURT_COURT_NAMES)) {
    const counted = await plNcourtCourtCount({
      courtId,
      signal,
      unfilteredTotal: total,
    });
    if (Result.isError(counted)) {
      return counted;
    }
    courts.push(counted.value);
  }
  let attributed = 0;
  for (const court of courts) {
    attributed += court.count;
  }
  return Result.ok({ total, courts, unattributed: total - attributed });
};

// ── Adapter ──────────────────────────────────────────────

export const plNcourtAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_NCOURT,
  language: PL_NCOURT_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // A page is one listing request (tens of seconds deep in the corpus) plus a
  // record and a document per row, two hundred rows at most, behind the gate.
  pageTimeoutMs: 10 * 60_000,
  maxCycleMs: 30 * 60_000,

  reparseStoredRaw: reparsePlNcourtStoredRaw,

  sourceSurfaces: PL_NCOURT_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_NCOURT_SOURCE_FIELDS,
    listSourceFields: listPlNcourtSourceFields,
  },

  getTotalCount: plNcourtTotalCount,

  reconciliation: {
    firstSlice: PL_NCOURT_FIRST_SLICE,
    ...plNcourtDaySlices.walk,
    tipWindowDays: PL_NCOURT_TIP_WINDOW_DAYS,
    heldRequiresDetail: true,
    listSlicePage: listPlNcourtSlicePage,
    buildDecision: buildPlNcourtFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plNcourtFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_NCOURT, cursor),
      }),
    );
  },
});
