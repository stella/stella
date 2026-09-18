import { Result, panic } from "better-result";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  backlogSurface,
  decodeSourceRawEnvelope,
  defineSourceAdapter,
  excludedSourceField,
  excludedSourceSurface,
  EMPTY_AST,
  encodeSourceRawEnvelope,
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
import { fetchPublisher } from "@/api/handlers/case-law/ingestion/adapters/retry";
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
import { czDecisionCourt } from "@/api/lib/case-law/cz-ecli-courts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
  sourceTextField,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
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

/**
 * The court a document is stored under when nothing about it names one.
 *
 * Not the label for everything this adapter fetches: the database is the
 * Supreme Court's, but its contents are not. It publishes selected decisions
 * of the high, regional, city and district courts too, naming the deciding
 * court both in the `Soud` row of every detail page and in the ECLI's court
 * code, so this constant covers only a document that states neither.
 */
const CZ_NS_PUBLISHER_COURT = "Nejvyšší soud";

/** The two pages fetched for one decision, as the stored raw names them. */
const CZ_NS_RAW_PART = {
  DETAIL: "detail",
  PRINT: "print",
} as const;

/** The Domino universal id as every NS listing and detail URL states it. */
const CZ_NS_DOCUMENT_ID_PATTERN = /^[0-9a-f]{32}$/iu;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A stored date as ISO, from either spelling this court's pages use.
 *
 * The print page's parser converts the Domino `M/D/YYYY` it expects and keeps
 * the page's own words for anything else, so a value read back from it is ISO
 * or the court's `D. M. YYYY`. Normalizing at the one place the row is written
 * keeps a single format under the key.
 */
const isoDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  return ISO_DATE_PATTERN.test(value) ? value : parseCeDate(value);
};

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
  /**
   * The deciding court, which this publisher states per decision because it
   * is not always its own: the database carries selected judgments of the
   * high, regional, city and district courts alongside the Supreme Court's.
   */
  court:
    /Soud:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
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
  /**
   * The court's own case annotation, which it prints under `Anotace:` beside
   * the headnote for part of its collection. Unlike every other row on this
   * page the cell holds a `<details>` disclosure rather than a `<font>` run,
   * so the value runs to the cell's close.
   */
  abstract: /Anotace:<\/font><\/b><\/td><td[^>]*>(?<value>[\s\S]*?)<\/td>/iu,
  /**
   * The day the document was handed to the web, which the detail page states
   * and the print page does not. It is the axis the reconciliation slices on,
   * so a row that carries it can be placed in the day it was published from
   * the row alone.
   */
  publishedOnWeb:
    /Zveřejněno na webu:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>(?<value>[\s\S]*?)<\/font>/iu,
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every field this court labels on the two pages read for one decision: the
 * detail page, and the print page whose metadata table the parser reads.
 *
 * Declared once so the disposition map below is total by type. The names are
 * the court's own labels, minus the colon it prints them with, because that
 * is what {@link listCzNsSourceFields} reads back off the page.
 */
const CZ_NS_SOURCE_FIELDS = [
  "Anotace",
  "Datum rozhodnutí",
  "Dotčené předpisy",
  "ECLI",
  "Heslo",
  "Kategorie rozhodnutí",
  "Podána ústavní stížnost",
  "Právní věta",
  "Senátní značka",
  "Soud",
  "Spisová značka",
  "Typ rozhodnutí",
  "Zveřejněno na webu",
] as const;

type CzNsSourceField = (typeof CZ_NS_SOURCE_FIELDS)[number];

const CZ_NS_SOURCE_FIELD_DISPOSITIONS = {
  Anotace: {
    disposition: "stored",
    target: { type: "textField", key: "abstract" },
  },
  "Datum rozhodnutí": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  "Dotčené předpisy": {
    disposition: "stored",
    target: { type: "metadata", key: "statutes" },
  },
  ECLI: { disposition: "stored", target: { type: "result", key: "ecli" } },
  Heslo: {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
  "Kategorie rozhodnutí": {
    disposition: "stored",
    target: { type: "metadata", key: "category" },
  },
  "Podána ústavní stížnost": {
    disposition: "stored",
    target: { type: "metadata", key: "ustavniStiznost" },
  },
  "Právní věta": {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  "Senátní značka": excludedSourceField(
    "The same docket under the label this court prints for its insolvency senate register. The row's docket is the one the listing entry states, which is what the document was fetched by.",
  ),
  /**
   * The deciding court, which is not always this publisher's own. Stored as
   * the row's court, through `czDecisionCourt`: where the decision's ECLI
   * names a court too, its code decides, so the corpus spells one court one
   * way whichever of the publisher's two spellings a page carries.
   */
  Soud: { disposition: "stored", target: { type: "result", key: "court" } },
  "Spisová značka": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "Typ rozhodnutí": {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  "Zveřejněno na webu": {
    disposition: "stored",
    target: { type: "metadata", key: "zverejnenoNaWebu" },
  },
} as const satisfies Record<CzNsSourceField, SourceFieldDisposition>;

/** The label cell of a detail-page row. */
const CZ_NS_DETAIL_LABEL_RE =
  /class="left-part"[^>]*>(?<cell>[\s\S]*?)<\/td>/giu;

/** The print page's metadata table, whose label cells carry no class. */
const CZ_NS_PRINT_TABLE_RE = /<table[^>]*id="box-table-a"[\s\S]*?<\/table>/iu;

const CZ_NS_CELL_RE = /<td[^>]*>(?<cell>[\s\S]*?)<\/td>/giu;

/**
 * The related-proceedings table, whose header spans the row rather than
 * labelling a cell, so it is recognised by its opening words instead. The
 * court sets each word in its own `<font>` run, so the two are some hundred
 * characters of markup apart on the page.
 */
const CZ_NS_CONSTITUTIONAL_COMPLAINT_RE =
  /Podána[\s\S]{0,200}?ústavní stížnost/iu;

/**
 * What this court labels on a page it serves for one decision.
 *
 * Both page shapes at once, because both are read for every decision and a
 * field is the court's whichever of the two prints it: the detail page marks
 * its label cells with a class, the print page states them in the first cell
 * of its metadata table. A cell is a label where the court closes it with a
 * colon, exactly as the readers above anchor on.
 */
const listCzNsSourceFields = (parts: SourceRawParts): readonly string[] => {
  const fields = new Set<string>();

  const addLabel = (cell: string): void => {
    const text = stripHtml(cell).trim();
    if (text.endsWith(":") && text.length > 1) {
      fields.add(text.slice(0, -1).trim());
    }
  };

  const detailHtml = parts[CZ_NS_RAW_PART.DETAIL] ?? "";
  for (const match of detailHtml.matchAll(CZ_NS_DETAIL_LABEL_RE)) {
    addLabel(match.groups?.["cell"] ?? "");
  }
  const printHtml = parts[CZ_NS_RAW_PART.PRINT] ?? "";
  const printTable = CZ_NS_PRINT_TABLE_RE.exec(printHtml)?.[0] ?? "";
  for (const match of printTable.matchAll(CZ_NS_CELL_RE)) {
    addLabel(match.groups?.["cell"] ?? "");
  }
  if (
    CZ_NS_CONSTITUTIONAL_COMPLAINT_RE.test(detailHtml) ||
    CZ_NS_CONSTITUTIONAL_COMPLAINT_RE.test(printHtml)
  ) {
    fields.add("Podána ústavní stížnost");
  }

  return [...fields];
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

/** Read every labelled row of a detail page into its own key. */
const parseDetailLabels = (
  html: string,
): Record<string, string | undefined> => {
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

  return result;
};

/**
 * What the court writes about a decision it selected into its collection:
 * the headnote, the annotation beside it, and the category letter that says
 * the decision is in the collection at all (`A`).
 *
 * Its own type because two readers want exactly these rows and no others —
 * the crawl, which reads them off a page it fetched for the decision text,
 * and a backfill, which fetches the page for these rows alone. Naming them
 * once is what keeps the two reading the same keys.
 */
export type CzNsPublishedSummary = {
  /** `Právní věta:`, the court's own headnote. */
  legalSentence: string | undefined;
  /** `Anotace:`, the court's own case annotation. */
  abstract: string | undefined;
  /** `Kategorie rozhodnutí:`; `A` is the published collection. */
  category: string | undefined;
};

const summaryOfLabels = (
  labels: Record<string, string | undefined>,
): CzNsPublishedSummary => ({
  legalSentence: labels["legalSentence"],
  abstract: labels["abstract"],
  category: labels["category"]?.trim(),
});

/**
 * The summary rows of a detail page, without the decision text beneath them.
 * The text is the expensive half of the page and a reader after the headnote
 * alone has no use for it.
 */
export const parseCzNsDetailSummary = (html: string): CzNsPublishedSummary =>
  summaryOfLabels(parseDetailLabels(html));

/** Parse metadata from a decision detail page. */
const parseDetailPage = (html: string): Record<string, string | undefined> => ({
  ...parseDetailLabels(html),
  fulltext: extractFulltext(html),
});

/** One decision as the publisher lists it, whichever listing named it. */
export type CzNsListingRow = {
  /** Domino universal id: the last path segment of the document's own URL. */
  unid: string;
  /** `znacka`, the docket exactly as the publisher writes it. */
  caseNumber: string;
  /** Other dockets settled by this same publisher document. */
  additionalCaseNumbers?: readonly string[] | undefined;
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
  caseNumber.length === 0 || !CZ_NS_DOCUMENT_ID_PATTERN.test(unid)
    ? null
    : { caseNumber, unid };

/**
 * The Domino view and older parked rows can carry a joined docket label;
 * HTML listings carry separate aliases. Preserve every docket while the
 * publisher's universal id continues to identify the document.
 */
const caseNumbersOf = ({
  caseNumber,
  additionalCaseNumbers,
}: CzNsListingRow): string[] => {
  const values =
    additionalCaseNumbers === undefined
      ? caseNumber.split(CASE_NUMBER_SEPARATOR)
      : [caseNumber, ...additionalCaseNumbers];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

/**
 * What building one listed decision produced. `detail-unavailable` carries
 * the status the publisher answered with so the crawl can log it; the
 * reconciliation drops it, having only the three outcomes its contract names.
 */
type CzNsBuildResult =
  | { type: "built"; decision: IngestionResult }
  | { type: "unkeyable" }
  | { type: "detail-unavailable"; httpStatus: number };

type BuildCzNsDecisionFromPagesOptions = {
  row: CzNsListingRow;
  webHtml: string;
  printHtml: string;
};

const buildCzNsDecisionFromPages = ({
  row,
  webHtml,
  printHtml,
}: BuildCzNsDecisionFromPagesOptions): IngestionResult | null => {
  const fields = czNsIdentityFields(row);
  if (fields === null) {
    return null;
  }
  const { unid } = fields;
  const caseNumbers = caseNumbersOf(row);
  const [caseNumber, ...additionalCaseNumbers] = caseNumbers;
  if (caseNumber === undefined) {
    return null;
  }
  const publisherIdentifiers = additionalCaseNumbers.map((value) => ({
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value,
  }));
  const [firstPublisherIdentifier, ...otherPublisherIdentifiers] =
    publisherIdentifiers;
  const webUrl = `${BASE_URL}/WebSearch/${unid}?openDocument`;
  const printUrl = `${BASE_URL}/WebPrint/${unid}?openDocument`;
  const meta = parseDetailPage(webHtml);
  const summary =
    meta["legalSentence"] === undefined && meta["abstract"] === undefined
      ? ""
      : `|${meta["legalSentence"] ?? ""}|${meta["abstract"] ?? ""}`;
  const publishedOnWeb =
    meta["publishedOnWeb"] === undefined
      ? undefined
      : parseCeDate(meta["publishedOnWeb"]);
  // The refresh gate compares only this hash before deciding whether to
  // project identifiers and metadata again. Keep the complete ordered docket
  // set in it, so an alias-only publisher edit cannot be mistaken for the
  // same observation.
  const raw = `${JSON.stringify(caseNumbers)}|${meta["ecli"] ?? ""}|${meta["court"] ?? ""}|${meta["decisionDate"] ?? ""}|${publishedOnWeb ?? ""}${summary}`;

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

  const judge = fulltext ? extractJudge(fulltext) : undefined;
  const court = czDecisionCourt({
    adapterKey: ADAPTER_KEYS.CZ_NS,
    ecli: meta["ecli"],
    publisherCourt: CZ_NS_PUBLISHER_COURT,
    sourceDocumentId: unid,
    statedCourt: meta["court"],
  });
  const publishedSummary = summaryOfLabels(meta);

  return {
    caseNumber,
    ...(firstPublisherIdentifier === undefined
      ? {}
      : {
          identifiers: [firstPublisherIdentifier, ...otherPublisherIdentifiers],
        }),
    sourceDocumentId: unid,
    legacySourceUrls: [webUrl],
    ecli: meta["ecli"],
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NS].country,
    language: CZ_NS_LANGUAGE,
    decisionDate: meta["decisionDate"]
      ? parseCeDate(meta["decisionDate"])
      : undefined,
    decisionType: meta["decisionType"]?.toLowerCase(),
    fulltext,
    sourceUrl: webUrl,
    documentUrl: webUrl,
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      abstract: sourceTextField(ADAPTER_KEYS.CZ_NS, publishedSummary.abstract),
      legalSentence: sourceTextField(
        ADAPTER_KEYS.CZ_NS,
        publishedSummary.legalSentence,
      ),
    },
    metadata: checkedDecisionMetadata({
      caseNumber,
      ecli: meta["ecli"],
      court,
      decisionDate: meta["decisionDate"]
        ? parseCeDate(meta["decisionDate"])
        : undefined,
      decisionType: meta["decisionType"]?.toLowerCase(),
      ...sourceMetadata,
      judge,
      category: publishedSummary.category,
      zverejnenoNaWebu:
        publishedOnWeb ?? isoDate(sourceMetadata["zverejnenoNaWebu"]),
      keywords: meta["keywords"]?.split("\n").flatMap((s) => {
        const trimmed = s.trim();
        return trimmed ? [trimmed] : [];
      }),
      statutes: meta["statutes"]?.split("\n").flatMap((s) => {
        const trimmed = s.trim();
        return trimmed ? [trimmed] : [];
      }),
      additionalCaseNumbers:
        additionalCaseNumbers.length > 0 ? additionalCaseNumbers : undefined,
    }),
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS],
    documentAst,
    sourceRaw: encodeSourceRawEnvelope({
      [CZ_NS_RAW_PART.DETAIL]: webHtml,
      [CZ_NS_RAW_PART.PRINT]: printHtml,
    }),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

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
  const { unid } = fields;

  const webUrl = `${BASE_URL}/WebSearch/${unid}?openDocument`;
  const printUrl = `${BASE_URL}/WebPrint/${unid}?openDocument`;

  // Detail and print pages in parallel; the pair is one document's worth of
  // work.
  const [detailResponse, printResponse] = await Promise.all([
    fetchPublisher(webUrl, {
      adapterKey: ADAPTER_KEYS.CZ_NS,
      signal,
      headers: COMMON_HEADERS,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    }),
    fetchPublisher(printUrl, {
      adapterKey: ADAPTER_KEYS.CZ_NS,
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
  const decision = buildCzNsDecisionFromPages({ row, webHtml, printHtml });
  return decision === null
    ? { type: "unkeyable" }
    : { type: "built", decision };
};

const CZ_NS_REPARSABLE_CONTENT_TYPES = new Set([
  "text/html",
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
]);

const storedRawParts = (
  raw: string,
): { webHtml: string; printHtml: string } | null => {
  const envelope = decodeSourceRawEnvelope(raw);
  if (envelope !== null) {
    const webHtml = envelope[CZ_NS_RAW_PART.DETAIL];
    const printHtml = envelope[CZ_NS_RAW_PART.PRINT];
    return typeof webHtml === "string" && typeof printHtml === "string"
      ? { webHtml, printHtml }
      : null;
  }

  const legacy = Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
  if (!isRecord(legacy)) {
    return null;
  }
  const webHtml = legacy["webHtml"];
  const printHtml = legacy["printHtml"];
  return typeof webHtml === "string" && typeof printHtml === "string"
    ? { webHtml, printHtml }
    : null;
};

type StoredAdditionalCaseNumbers =
  | { type: "missing" }
  | { type: "valid"; value: readonly string[] }
  | { type: "invalid" };

const storedAdditionalCaseNumbers = (
  metadata: Record<string, unknown>,
): StoredAdditionalCaseNumbers => {
  const value = metadata["additionalCaseNumbers"];
  if (value === undefined) {
    return { type: "missing" };
  }
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
    ? { type: "valid", value }
    : { type: "invalid" };
};

/**
 * Rebuild a decision from either generation of the saved two-page payload.
 * Legacy rows carry their complete docket list in the joined `caseNumber`,
 * while current rows carry aliases in metadata; neither needs a source fetch.
 */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !CZ_NS_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }
  if (stored.sourceDocumentId === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "missing source document id",
    };
  }
  if (!CZ_NS_DOCUMENT_ID_PATTERN.test(stored.sourceDocumentId)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: "stored source document id is not a CZ-NS Domino universal id",
    };
  }
  const additionalCaseNumbers = storedAdditionalCaseNumbers(stored.metadata);
  if (additionalCaseNumbers.type === "invalid") {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "stored additional case numbers are malformed",
    };
  }

  const raw = new TextDecoder().decode(stored.raw);
  const parts = storedRawParts(raw);
  if (parts === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: `no decision pages in the stored payload for ${stored.caseNumber}`,
    };
  }
  const result = buildCzNsDecisionFromPages({
    row: {
      unid: stored.sourceDocumentId,
      caseNumber: stored.caseNumber,
      additionalCaseNumbers:
        additionalCaseNumbers.type === "valid"
          ? additionalCaseNumbers.value
          : undefined,
    },
    webHtml: parts.webHtml,
    printHtml: parts.printHtml,
  });
  if (result === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `stored identity is invalid for ${stored.caseNumber}`,
    };
  }
  return {
    type: "parsed",
    result: {
      ...result,
      sourceRaw: raw,
      sourceRawContentType: stored.contentType ?? undefined,
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
export const CZ_NS_FIRST_SLICE =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NS].dateRange.fromInclusive;

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
  const start = Temporal.PlainDate.from(slice);
  const day = String(start.day).padStart(2, "0");
  const month = String(start.month).padStart(2, "0");
  return `${day}.${month}.${String(start.year).padStart(4, "0")}`;
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
 * `stripHtml` preserves the publisher's `<br />` between co-settled dockets
 * as line breaks. Keep each docket separate for identifier persistence.
 */
const parseListingCaseNumbers = (raw: string): string[] =>
  stripHtml(raw)
    .split("\n")
    .flatMap((part) => {
      const trimmed = part.trim();
      return trimmed.length === 0 ? [] : [trimmed];
    });

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
  [...html.matchAll(LISTING_ROW_PATTERN)].map((match) => {
    const caseNumbers = parseListingCaseNumbers(
      match.groups?.["caseNumber"] ?? "",
    );
    const caseNumber = caseNumbers.at(0) ?? "";
    const additionalCaseNumbers = caseNumbers.slice(1);
    return {
      unid: match.groups?.["unid"] ?? "",
      caseNumber,
      additionalCaseNumbers:
        additionalCaseNumbers.length > 0 ? additionalCaseNumbers : undefined,
    };
  });

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

  const response = await fetchPublisher(url, {
    adapterKey: ADAPTER_KEYS.CZ_NS,
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
  typeof value["caseNumber"] === "string" &&
  (value["additionalCaseNumbers"] === undefined ||
    (Array.isArray(value["additionalCaseNumbers"]) &&
      value["additionalCaseNumbers"].every(
        (item) => typeof item === "string" && item.trim().length > 0,
      )));

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
      built satisfies never;
      return panic(`Unhandled cz-ns build result: ${JSON.stringify(built)}`);
    }
  }
};

/**
 * Every page this court serves for one decision, and whether the row keeps it.
 *
 * The crawl reads a listing view for identities and then two renderings of the
 * decision, and keeps the two renderings. The listing rows are not kept, and
 * the word-processor and portable-document attachments are addressed by an
 * identifier that appears on a listing the crawl does not walk — so reaching
 * them is a question about which listing the crawl uses, not an extra fetch.
 */
const SOURCE_SURFACES = [
  "listing",
  "slice-listing",
  "detail",
  "print",
  "document-pdf",
  "document-rtf",
  "citation-popup",
  "citation-popup-ecli",
  "sitemaps",
] as const;

const CZ_NS_SOURCE_SURFACES = {
  surfaces: {
    listing: backlogSurface(
      ADAPTER_KEYS.CZ_NS,
      "the listing row the crawl walks for identities is not kept beside the decision it names",
    ),
    "slice-listing": backlogSurface(
      ADAPTER_KEYS.CZ_NS,
      "the publication-day listing is the only page stating the attachment identifiers, and the crawl walks the identifier-ordered view instead",
    ),
    detail: storedSourceSurface(CZ_NS_RAW_PART.DETAIL),
    print: storedSourceSurface(CZ_NS_RAW_PART.PRINT),
    "document-pdf": backlogSurface(
      ADAPTER_KEYS.CZ_NS,
      "the attachment carries an identifier of its own, stated only on the listing the crawl does not walk, and its bytes need an object part rather than a text one",
    ),
    "document-rtf": backlogSurface(
      ADAPTER_KEYS.CZ_NS,
      "the word-processor original the court attaches, reachable and storable on the same terms as the portable-document attachment",
    ),
    "citation-popup": excludedSourceSurface(
      "a citation sentence assembled from fields the row already stores, and the publisher's own template drops part of the date",
    ),
    "citation-popup-ecli": excludedSourceSurface(
      "the same assembled sentence with the identifier the row already stores",
    ),
    sitemaps: excludedSourceSurface(
      "corpus-wide addresses, not a payload about any one decision",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

export const czNsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_NS,
  sourceSurfaces: CZ_NS_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: CZ_NS_SOURCE_FIELD_DISPOSITIONS,
    listSourceFields: listCzNsSourceFields,
  },
  language: CZ_NS_LANGUAGE,
  minRequestIntervalMs: 200,
  reparseStoredRaw,
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

      const response = await fetchPublisher(url, {
        adapterKey: ADAPTER_KEYS.CZ_NS,
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

        const listResponse = await fetchPublisher(listUrl, {
          adapterKey: ADAPTER_KEYS.CZ_NS,
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
                built satisfies never;
                return panic(
                  `Unhandled cz-ns build result: ${JSON.stringify(built)}`,
                );
              }
            }
          } catch (error) {
            // Caller cancelled: return partial results
            if (error instanceof DOMException && error.name === "AbortError") {
              return {
                decisions,
                nextCursor: String(start + i),
                sourceUrl: listUrl,
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
                  sourceUrl: listUrl,
                };
              }
              // Per-entry timeout: skip this entry
              continue;
            }
            throw error;
          }
        }

        // Exhausted or not, the cursor stops where the view stopped. Parking
        // a page back instead re-read the same forty entries every cycle and
        // spent two detail requests on each of them — eighty requests an hour
        // for decisions already held — and it bought nothing: this view is
        // ordered by document id, so what the court adds lands after the
        // cursor, not behind it. A record that does land behind it is the
        // reconciliation ledger's to find, which lists a date in one request.
        //
        // Never null — that restarts the full scan from position 1.
        const nextCursor = String(start + entries.length);

        return { decisions, nextCursor, sourceUrl: listUrl };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_NS, cursor),
    });
  },
});
