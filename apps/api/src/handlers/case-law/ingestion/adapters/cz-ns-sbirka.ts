// parser-output-unchanged: imports moved to @stll/case-law-parsers; runtime behavior unchanged.
// parser-output-unchanged: dot-notation property access on LANGUAGE_STOPWORDS preserves identical runtime output
/**
 * The Supreme Court's official collection, the Sbírka soudních rozhodnutí a
 * stanovisek, from sbirka.nsoud.cz.
 *
 * The collection is a WordPress site. Each entry is one post with one detail
 * page (`/sbirka/<post id>/`) stating the entry's fields in a labelled table
 * and the collection's edited text of the decision beneath them; see the
 * parser for the page. The research note beside this file records the
 * surfaces, counts and pace.
 *
 * Identity. The post id is the document id. The ECLI the page heading states
 * is stored as the publisher spells it: for many entries that spelling differs
 * from the court's own database (a four-digit docket year, `NSČR` with its
 * diacritic), and no stage of the pipeline rewrites a stated ECLI, so the
 * stated one does not name the decision across sources.
 *
 * Crawl. The publisher lists every entry in its sitemaps
 * (`collection-sitemap.xml`, `collection-sitemap2.xml`, …), one entry per URL
 * with its `lastmod`, ordered by `lastmod` across the whole set: an entry the
 * publisher edits moves to the end. So the cursor is the last entry read, by
 * `lastmod` and post id, not a position: the walk reads every entry once,
 * reaches the newest, and from then on meets each new or edited entry as it
 * appears after the cursor. The sitemap the cursor sits in is re-read before
 * the walk moves to the next, because an edit elsewhere shifts every later
 * entry one place towards the start and can carry one across the boundary.
 *
 * Detail pages are read one at a time at the publisher's gate (one request a
 * second). A page the publisher no longer serves (404, 410) is skipped; a
 * refused one is counted; one that could not be read halts the cycle with the
 * cursor where it was, as a 429 does by itself.
 *
 * Reconciliation. The collection archive lists entries by collection year
 * (`/year-collection/rok-1971/`), the interwar Vážný volumes under one term of
 * their own, seven to a page. A slice is one year, or the Vážný volumes.
 *
 * Merging. A post-1993 Supreme Court entry is a decision `cz-ns` also holds.
 * This adapter builds every entry as a decision of its own, carrying the
 * typed collection entry under one metadata key
 * (`lib/legal-search/cz-ns-collection-entry.ts`); whether an entry becomes a
 * row of its own or attaches to the decision already held is decided where it
 * is written, not here.
 */
import { panic, Result } from "better-result";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  czNsCollectionIdentifierValues,
  formatCzNsCollectionCitation,
} from "@stll/api-contract/cz-ns-collection-citation";
import {
  DECISION_DOCKET_GRAMMARS,
  formatDecisionDocket,
} from "@stll/api-contract/decision-docket-grammar";
import { toMetadataUrl } from "@stll/case-law-parsers/sanitize-url";
import { visibleHtmlText } from "@stll/case-law-parsers/shared-inlines";
import { load } from "@stll/html";
import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { Temporal } from "@stll/time";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readPublisherText,
  unreadPublisherError,
  type UnreadPublisherOutcome,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { publisherTarget } from "@/api/handlers/case-law/ingestion/adapters/publisher-target";
import {
  adapterCatch,
  INGESTION_USER_AGENT,
  parseCeDate,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  CZ_NS_SBIRKA_TEXT_HEADING,
  type CzNsSbirkaPage,
  type CzNsSbirkaParsedDocument,
  parseCzNsSbirkaText,
  readCzNsSbirkaPage,
} from "@/api/handlers/case-law/ingestion/parsers/cz-ns-sbirka";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { czDecisionCourt } from "@/api/lib/case-law/cz-ecli-courts";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  sourceTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  CZ_NS_COLLECTION_METADATA_KEY,
  CZ_NS_COLLECTION_METADATA_URL_SCHEMA,
  type CzNsCollectionEntry,
  czNsCollectionPartOfKind,
} from "@/api/lib/legal-search/cz-ns-collection-entry";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  CZ_NS_SBIRKA_VAZNY_SLICE,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceSurface,
  PUBLISHER_REQUEST,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  EmptyAst,
  IngestionResult,
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
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { logger } from "@/api/lib/observability/logger";
import { LANGUAGE_STOPWORDS } from "@/api/lib/templates/template-languages";
import { isRecord } from "@/api/lib/type-guards";

const KEY = ADAPTER_KEYS.CZ_NS_SBIRKA;
const ORIGIN = "https://sbirka.nsoud.cz";
const SITEMAP_INDEX_URL = `${ORIGIN}/sitemap_index.xml`;
const MANIFEST = ADAPTER_MANIFESTS[KEY];

/** The language most entries are in; a Slovak entry is told by its text. */
const DEFAULT_LANGUAGE = "cs";

const COMMON_HEADERS = { "User-Agent": INGESTION_USER_AGENT } as const;

/**
 * Entries read per page. At one request a second a page is about twenty-five
 * seconds of requests, the sitemap index and one sitemap included.
 */
export const CZ_NS_SBIRKA_PAGE_SIZE = 20;

/** Room for a page's requests at the gate's pace, with slow answers. */
const PAGE_TIMEOUT_MS = 2 * 60_000;

/** Pages per cycle: twenty pages of twenty entries stay inside one cycle. */
const MAX_SYNC_PAGES = 20;

/** What one decision's stored raw names its parts. */
const RAW_PART = {
  /** The listed entry: its post id. */
  LISTING: "listing",
  /** The entry's detail page, verbatim. */
  DETAIL: "detail",
} as const;

// ── Addresses ────────────────────────────────────────────

const POST_ID_PATTERN = /^\d{1,9}$/u;
const ENTRY_URL_PATTERN =
  /^https:\/\/sbirka\.nsoud\.cz\/sbirka\/(?<postId>\d{1,9})\/$/u;
const COLLECTION_SITEMAP_PATTERN =
  /^https:\/\/sbirka\.nsoud\.cz\/collection-sitemap(?<number>\d{0,4})\.xml$/u;

export const czNsSbirkaEntryUrl = (postId: string): string =>
  `${ORIGIN}/sbirka/${postId}/`;

const postIdOfUrl = (url: string): string | undefined =>
  ENTRY_URL_PATTERN.exec(url.trim())?.groups?.["postId"];

// ── Detail page → decision ───────────────────────────────

/**
 * The page heading: "Rozsudek Nejvyššího soudu SSR ze dne 14.10.1970, sp. zn.
 * 6 Cz 90/70, ECLI:CZ:NS:1970:6.CZ.90.1970.1". The docket marker is `sp. zn.`
 * or `sen. zn.`, and a few interwar headings leave it out; the ECLI is absent
 * from some older entries.
 */
const TITLE_DATE_MARK = " ze dne ";
const TITLE_DATE = /^\d{1,2}\. ?\d{1,2}\. ?\d{4}$/u;
const TITLE_DOCKET_MARK = /^(?:sp|sen)\. ?zn\. ?/u;
const ECLI_PREFIX = "ECLI:";

type TitleParts = {
  head: string | undefined;
  date: string | undefined;
  docket: string | undefined;
  ecli: string | undefined;
};

const NO_TITLE_PARTS: TitleParts = {
  head: undefined,
  date: undefined,
  docket: undefined,
  ecli: undefined,
};

/** The heading's parts, read off its comma-separated statements in order. */
const titleParts = (title: string | undefined): TitleParts => {
  const at = title?.indexOf(TITLE_DATE_MARK) ?? -1;
  if (title === undefined || at < 0) {
    return NO_TITLE_PARTS;
  }
  const [date, ...rest] = title
    .slice(at + TITLE_DATE_MARK.length)
    .split(",")
    .map((part) => part.trim());
  if (date === undefined || !TITLE_DATE.test(date)) {
    return NO_TITLE_PARTS;
  }
  const last = rest.at(-1);
  const ecli = last?.startsWith(ECLI_PREFIX) === true ? last : undefined;
  const docket = (ecli === undefined ? rest : rest.slice(0, -1))
    .join(", ")
    .replace(TITLE_DOCKET_MARK, "")
    .trim();
  return {
    head: title.slice(0, at).trim(),
    date,
    docket: docket === "" ? undefined : docket,
    ecli,
  };
};

/**
 * The decision types the collection states in its `Typ rozhodnutí` row, for an
 * entry whose page states the type only in its heading. Longest first, so
 * "Výtah z materiálu" is not read as a shorter type.
 */
const TITLE_DECISION_TYPES = [
  "Výtah z materiálu",
  "Rozhodnutí",
  "Stanovisko",
  "Zhodnocení",
  "Rozsudek",
  "Usnesení",
  "Závěry",
  "Zpráva",
  "Nález",
] as const;

const decisionTypeOfTitle = (head: string | undefined): string | undefined =>
  head === undefined
    ? undefined
    : TITLE_DECISION_TYPES.find((type) => head.startsWith(`${type} `));

/**
 * The court a heading names, in the nominative: "Usnesení Krajského soudu v
 * Hradci Králové" names "Krajský soud v Hradci Králové". A court's name opens
 * with an adjective in the genitive (`-ého`, `-ího`) before `soudu`, and the
 * rest of the name (the seat, `ČSSR`) does not decline. Read only for an
 * entry whose page states no `Soud` row.
 */
const CAPITALISED = /^\p{Lu}/u;
const GENITIVE_ENDINGS = { ého: "ý", ího: "í" } as const;

const courtOfTitle = (head: string | undefined): string | undefined => {
  const words = head === undefined ? [] : head.split(" ");
  const noun = words.lastIndexOf("soudu");
  const adjective = noun > 0 ? words[noun - 1] : undefined;
  if (adjective === undefined || !CAPITALISED.test(adjective)) {
    return undefined;
  }
  const ending = Object.entries(GENITIVE_ENDINGS).find(([genitive]) =>
    adjective.endsWith(genitive),
  );
  if (ending === undefined) {
    return undefined;
  }
  const [genitive, nominative] = ending;
  return [
    `${adjective.slice(0, -genitive.length)}${nominative}`,
    "soud",
    ...words.slice(noun + 1),
  ].join(" ");
};

/** "Rok 1971" and "Sešit č. 1/1971" in the breadcrumb. */
const BREADCRUMB_YEAR = /^Rok\s+(?<year>\d{4})$/u;
const BREADCRUMB_ISSUE = /^Sešit\s+č\.\s*(?<issue>[\d-]+)\/\d{4}$/u;

const breadcrumbValue = (
  breadcrumb: readonly string[],
  pattern: RegExp,
  group: string,
): string | undefined => {
  for (const link of breadcrumb) {
    const value = pattern.exec(link)?.groups?.[group];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
};

/** A row's lines; none where the page states no such row. */
const rowLines = (page: CzNsSbirkaPage, label: string): string[] => {
  const lines = page.fields.get(label);
  return lines === undefined ? [] : [...lines];
};

/** A single-valued row's text: its lines joined. */
const rowText = (page: CzNsSbirkaPage, label: string): string | undefined => {
  const lines = page.fields.get(label);
  return lines === undefined || lines.length === 0
    ? undefined
    : lines.join(" ");
};

/** A multi-line row's text, line breaks kept. */
const rowParagraphs = (
  page: CzNsSbirkaPage,
  label: string,
): string | undefined => {
  const lines = page.fields.get(label);
  return lines === undefined || lines.length === 0
    ? undefined
    : lines.join("\n");
};

/**
 * `Heslo`, one entry per keyword. The page prints each keyword as a chip of
 * its own, and the row joins them with ", ", which some keywords contain
 * ("Zkrácení daně, poplatku a podobné povinné platby"): the chips are the
 * list, the row the fallback where a page prints none.
 */
const keywordsOf = (page: CzNsSbirkaPage): string[] => {
  if (page.keywordChips.length > 0) {
    return [...page.keywordChips];
  }
  return (rowText(page, "Heslo") ?? "").split(", ").flatMap((keyword) => {
    const trimmed = keyword.trim();
    return trimmed === "" ? [] : [trimmed];
  });
};

/** Several dockets the collection states for one entry, joined by ", ". */
const DOCKET_SEPARATOR = ", ";

/** How `caseNumber` was read from the stated docket. */
const CASE_NUMBER_READING = {
  /** The CZE docket grammar read it; stored in the grammar's spelling. */
  GRAMMAR: "grammar",
  /** The grammar reads no docket of this form; stored as stated. */
  AS_STATED: "as-stated",
  /**
   * The entry states no docket anywhere (a plenary directive printed under
   * its collection number alone): the label is the post id, marked as a
   * placeholder rather than a docket.
   */
  PLACEHOLDER: "placeholder",
} as const;

type CaseNumberReading =
  (typeof CASE_NUMBER_READING)[keyof typeof CASE_NUMBER_READING];

type Dockets = {
  caseNumber: string;
  sheetNumber: string | undefined;
  additionalCaseNumbers: string[];
  reading: CaseNumberReading;
};

/**
 * The stated docket through the CZE grammar: old two-digit years (`6 Cz
 * 90/70`) and the opinion registers (`Cpjn 38/98`, `Tpjn 300/2000`, `S
 * 296/99`) read as any other. A row stating several dockets (`29 NSCR
 * 55/2019, 29 NSCR 111/2019`) is split only where every part reads as a
 * docket, so one docket covering several numbers (`25 Co 498, 499/97`) stays
 * whole. A form the grammar does not read (`Kr I 4/19`) is kept as stated.
 */
export const czNsSbirkaDockets = (stated: string): Dockets => {
  const parts = stated.split(DOCKET_SEPARATOR).map((part) => part.trim());
  const parsed = parts.map((part) => {
    const { caseNumber, sheetNumber } = splitCaseReference(part);
    const docket = DECISION_DOCKET_GRAMMARS.CZE.parse(caseNumber);
    return docket === null
      ? null
      : { caseNumber: formatDecisionDocket(docket), sheetNumber };
  });
  const [first, ...rest] = parsed;
  if (first === undefined || first === null || rest.some((p) => p === null)) {
    const whole = splitCaseReference(stated);
    const docket = DECISION_DOCKET_GRAMMARS.CZE.parse(whole.caseNumber);
    return docket === null
      ? {
          caseNumber: stated.trim(),
          sheetNumber: undefined,
          additionalCaseNumbers: [],
          reading: CASE_NUMBER_READING.AS_STATED,
        }
      : {
          caseNumber: formatDecisionDocket(docket),
          sheetNumber: whole.sheetNumber,
          additionalCaseNumbers: [],
          reading: CASE_NUMBER_READING.GRAMMAR,
        };
  }
  return {
    caseNumber: first.caseNumber,
    sheetNumber: first.sheetNumber,
    additionalCaseNumbers: rest.flatMap((part) =>
      part === null ? [] : [part.caseNumber],
    ),
    reading: CASE_NUMBER_READING.GRAMMAR,
  };
};

const CS_STOPWORDS = new Set(LANGUAGE_STOPWORDS.cs);
const SK_STOPWORDS = new Set(LANGUAGE_STOPWORDS.sk);

/**
 * The entry's language, read from its own words. The collection prints the
 * Slovak courts' decisions, and some federal ones, in Slovak, under any court
 * label: the court does not say. The two stopword lists are disjoint by
 * construction, so the language with more hits is the text's; a tie, or a
 * text with none, is the publisher's Czech.
 */
export const czNsSbirkaLanguageOf = (texts: readonly string[]): string => {
  let czech = 0;
  let slovak = 0;
  for (const text of texts) {
    for (const [word] of text.toLocaleLowerCase("cs").matchAll(/\p{L}+/gu)) {
      if (CS_STOPWORDS.has(word)) {
        czech += 1;
      } else if (SK_STOPWORDS.has(word)) {
        slovak += 1;
      }
    }
  }
  return slovak > czech ? "sk" : DEFAULT_LANGUAGE;
};

const NUMBER_PATTERN = /^\d{1,4}$/u;
const YEAR_PATTERN = /^\d{4}$/u;

/**
 * A run of digits as its number. Every caller has matched the text against a
 * bounded digit pattern first, so a failed parse is an impossible state.
 */
const integerOf = (digits: string): number => {
  const parsed = parseIntegerToken(digits, { sign: "unsigned" });
  return Result.isOk(parsed)
    ? parsed.value
    : panic(`validated digits did not parse: ${digits}`);
};

/** The reporter citations an entry is stored under, where it has a number. */
const collectionIdentifiers = (
  entry: Pick<CzNsCollectionEntry, "part" | "number" | "year">,
): DecisionIdentifier[] => {
  const { part, number, year } = entry;
  const numbered =
    number === null || !NUMBER_PATTERN.test(number)
      ? undefined
      : integerOf(number);
  if (numbered === undefined || year === null) {
    return [];
  }
  const place = { number: numbered, year };
  const values =
    part === null
      ? [formatCzNsCollectionCitation({ ...place, part: null })]
      : czNsCollectionIdentifierValues({ ...place, part });
  return values.map((value) => ({
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value,
  }));
};

const listingRowOf = (postId: string): string => JSON.stringify({ postId });

/** The stated docket, else the heading's, else the post id as a placeholder. */
const docketsOf = (
  page: CzNsSbirkaPage,
  title: TitleParts,
  postId: string,
): Dockets => {
  const stated = rowText(page, "Spisová značka") ?? title.docket;
  return stated === undefined
    ? {
        caseNumber: postId,
        sheetNumber: undefined,
        additionalCaseNumbers: [],
        reading: CASE_NUMBER_READING.PLACEHOLDER,
      }
    : czNsSbirkaDockets(stated);
};

/**
 * The stated type, lowercased. A type row holding a docket ("Cz 509/56") is
 * a column read out of place, not a type: the heading's type answers instead.
 */
const decisionTypeOf = (
  page: CzNsSbirkaPage,
  title: TitleParts,
): string | undefined => {
  const stated = rowText(page, "Typ rozhodnutí");
  return (
    stated !== undefined && DECISION_DOCKET_GRAMMARS.CZE.parse(stated) === null
      ? stated
      : decisionTypeOfTitle(title.head)
  )?.toLocaleLowerCase("cs");
};

type BuildCzNsSbirkaOptions = {
  postId: string;
  detailHtml: string;
};

/**
 * One entry as a decision, from its detail page alone. Null where the page
 * has no heading, which no entry page lacks.
 */
export const buildCzNsSbirkaDecision = ({
  postId,
  detailHtml,
}: BuildCzNsSbirkaOptions): IngestionResult | null => {
  if (!POST_ID_PATTERN.test(postId)) {
    return null;
  }
  const page = readCzNsSbirkaPage(detailHtml);
  const title = titleParts(page.title);
  // The row is the statement; the heading answers only where a page states
  // no row, and is kept whole in the entry either way. The two can disagree
  // (a heading dated 2020 over a row dated 2022), and the row is stored.
  if (page.title === undefined) {
    return null;
  }
  const dockets = docketsOf(page, title, postId);
  const sourceUrl = czNsSbirkaEntryUrl(postId);
  const ecli = title.ecli;
  const decisionDateText = rowText(page, "Datum rozhodnutí") ?? title.date;
  const decisionDate =
    decisionDateText === undefined ? undefined : parseCeDate(decisionDateText);
  const decisionType = decisionTypeOf(page, title);
  const statedCourt = rowText(page, "Soud");
  const court = czDecisionCourt({
    adapterKey: KEY,
    ecli,
    publisherCourt: MANIFEST.publisher,
    sourceDocumentId: postId,
    statedCourt: statedCourt ?? courtOfTitle(title.head),
  });
  const kind = rowText(page, "Druh") ?? null;
  const yearText =
    rowText(page, "Rok") ??
    breadcrumbValue(page.breadcrumb, BREADCRUMB_YEAR, "year");
  const keywords = keywordsOf(page);
  const citedProvisions = rowLines(page, "Předpisy");
  const legalSentence = rowParagraphs(page, "Právní věta");
  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let fulltext: string | undefined;
  let sections: IngestionResult["sections"];
  let report: CzNsSbirkaParsedDocument["reportEdition"];
  if (page.textHtml !== undefined) {
    const parsed = parseCzNsSbirkaText(page.textHtml, {
      postId,
      sourceUrl,
      caseNumber: dockets.caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      keywords,
      statutes: citedProvisions,
    });
    // An entry whose text cell the publisher left empty is stored without a
    // document: the page states the entry, and its text is not published.
    if (Result.isOk(parsed)) {
      ({
        documentAst,
        fulltext,
        sections,
        reportEdition: report,
      } = parsed.value);
    }
  }

  const entry: CzNsCollectionEntry = {
    postId,
    title: page.title,
    kind,
    part: czNsCollectionPartOfKind(kind),
    number:
      rowText(page, "Číslo rozhodnutí") ??
      (report?.extent === "section" ? report.number : null),
    ...(report === undefined ? {} : { reportEdition: report }),
    year:
      yearText !== undefined && YEAR_PATTERN.test(yearText)
        ? integerOf(yearText)
        : null,
    issue:
      rowText(page, "Sešit") ??
      breadcrumbValue(page.breadcrumb, BREADCRUMB_ISSUE, "issue") ??
      null,
    legalSentence: legalSentence ?? null,
    keywords,
    citedProvisions,
    affectedDecisions: rowLines(page, "Dotčená rozhodnutí"),
    constitutionalComplaint: rowParagraphs(page, "Ústavní stížnost") ?? null,
    statedCourt: statedCourt ?? null,
    exports: {
      pdf:
        page.exports.pdf === undefined
          ? undefined
          : toMetadataUrl(page.exports.pdf, "decoded"),
      epub:
        page.exports.epub === undefined
          ? undefined
          : toMetadataUrl(page.exports.epub, "decoded"),
    },
  };

  const identifiers: DecisionIdentifier[] = [
    ...dockets.additionalCaseNumbers.map((value) => ({
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value,
    })),
    ...collectionIdentifiers(entry),
  ];
  const [firstIdentifier, ...otherIdentifiers] = identifiers;
  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.LISTING]: listingRowOf(postId),
    [RAW_PART.DETAIL]: detailHtml,
  });

  return plainTextIngestionResult({
    caseNumber: dockets.caseNumber,
    ...(dockets.reading === CASE_NUMBER_READING.PLACEHOLDER
      ? { caseNumberIsPlaceholder: true }
      : {}),
    ...(dockets.sheetNumber === undefined
      ? {}
      : { sheetNumber: dockets.sheetNumber }),
    ...(firstIdentifier === undefined
      ? {}
      : { identifiers: [firstIdentifier, ...otherIdentifiers] }),
    sourceDocumentId: postId,
    ecli,
    court,
    country: MANIFEST.country,
    language: czNsSbirkaLanguageOf([legalSentence ?? "", fulltext ?? ""]),
    decisionDate,
    decisionType,
    fulltext,
    sourceUrl,
    documentUrl: sourceUrl,
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      legalSentence: sourceTextField(KEY, legalSentence),
      abstract: sourceTextField(KEY, rowParagraphs(page, "Anotace")),
    },
    metadata: checkedDecisionMetadata(
      {
        [CZ_NS_COLLECTION_METADATA_KEY]: entry,
        caseNumberReading: dockets.reading,
        ...(dockets.additionalCaseNumbers.length === 0
          ? {}
          : { additionalCaseNumbers: dockets.additionalCaseNumbers }),
      },
      CZ_NS_COLLECTION_METADATA_URL_SCHEMA,
    ),
    rawHash: sourceFingerprint({ sourceRaw }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS_SBIRKA],
    documentAst,
    sections,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
};

// ── Reads ────────────────────────────────────────────────

type ListingRead = { type: "present"; body: string } | { type: "absent" };

const listingError = (message: string, cursor: string | null) =>
  new AdapterFetchError({ message, adapterKey: KEY, cursor });

/**
 * A listing read (sitemap or archive page) as text, or the error that fails
 * the page. A sitemap's address is one the index handed back: it is held to
 * the publisher's own hosts like every address read here.
 */
const readListing = async (
  url: string,
  cursor: string | null,
  signal: AbortSignal | undefined,
): Promise<Result<ListingRead, AdapterFetchError>> => {
  const target = publisherTarget(KEY, url);
  if (Result.isError(target)) {
    return Result.err(
      new AdapterFetchError({
        message: target.error.message,
        adapterKey: KEY,
        cursor,
        cause: target.error,
      }),
    );
  }
  const read = await readPublisherText(target.value, {
    fetchStage: "listing",
    adapterKey: KEY,
    signal,
    headers: COMMON_HEADERS,
    timeoutMs: ADAPTER_TIMEOUT.LIST,
    refusalScope: "source",
  });
  switch (read.type) {
    case "present":
      return Result.ok({ type: "present", body: read.value });
    case "absent":
      return Result.ok({ type: "absent" });
    case "refused":
    case "unavailable":
      return Result.err(
        unreadPublisherError({
          outcome: read,
          message: `Collection listing ${url} could not be read`,
          adapterKey: KEY,
          cursor,
        }),
      );
    default:
      read satisfies never;
      return panic(
        `Unhandled collection listing read: ${JSON.stringify(read)}`,
      );
  }
};

/** What reading one entry's detail page established. */
export type CzNsSbirkaEntryRead =
  | { type: "built"; decision: IngestionResult }
  /** Built, and stored with the raw it was refused from, as every source does. */
  | { type: "build-failed"; decision: IngestionResult }
  | { type: "unkeyable" }
  /**
   * The publisher no longer serves the entry (404 or 410), or refused this one
   * page (401, 403, 451): the read, as it was established.
   */
  | { type: "unread"; read: UnreadPublisherOutcome };

/**
 * Read and build one entry. A page that could not be read is an error: the
 * crawl and the reconciliation each stop rather than store or skip an entry
 * nobody has seen.
 */
export const readCzNsSbirkaEntry = async (
  postId: string,
  cursor: string | null,
  signal: AbortSignal | undefined,
): Promise<Result<CzNsSbirkaEntryRead, AdapterFetchError>> => {
  const read = await readPublisherText(`${ORIGIN}/sbirka/${postId}/`, {
    fetchStage: "document",
    adapterKey: KEY,
    signal,
    headers: COMMON_HEADERS,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    refusalScope: "document",
  });
  switch (read.type) {
    case "present": {
      const attempted = await buildPlainTextItem({
        adapterKey: KEY,
        rawListing: listingRowOf(postId),
        build: async () =>
          await Promise.resolve(
            buildCzNsSbirkaDecision({ postId, detailHtml: read.value }),
          ),
        decisionOf: (decision) => decision ?? undefined,
      });
      if (attempted.type === "item_build_failed") {
        return Result.ok({
          type: "build-failed",
          decision: attempted.decision,
        });
      }
      return Result.ok(
        attempted.value === null
          ? { type: "unkeyable" }
          : { type: "built", decision: attempted.value },
      );
    }
    case "absent":
    case "refused":
      return Result.ok({ type: "unread", read });
    case "unavailable":
      return Result.err(
        unreadPublisherError({
          outcome: read,
          message: `Collection entry ${postId} could not be read`,
          adapterKey: KEY,
          cursor,
        }),
      );
    default:
      read satisfies never;
      return panic(`Unhandled collection entry read: ${JSON.stringify(read)}`);
  }
};

// ── Sitemaps ─────────────────────────────────────────────

/** One entry as a sitemap lists it. */
type CzNsSbirkaSitemapEntry = {
  postId: string;
  /** `lastmod` as the sitemap states it. */
  lastmod: string;
};

/** The text of each `<tag>…</tag>` element, in order. */
const elementsOf = (xml: string, tag: string): string[] => {
  const close = `</${tag}>`;
  return xml
    .split(`<${tag}>`)
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf(close);
      return end === -1 ? chunk : chunk.slice(0, end);
    });
};

/** The trimmed text of the first `<tag>` inside `block`, if any. */
const fieldOf = (block: string, tag: string): string | undefined =>
  elementsOf(block, tag).at(0)?.trim();

const instantOf = (lastmod: string): Temporal.Instant | null =>
  Result.try(() => Temporal.Instant.from(lastmod)).unwrapOr(null);

/**
 * The collection sitemaps the index lists, in the publisher's numbering:
 * `collection-sitemap.xml` first, then `collection-sitemap2.xml` onwards.
 */
export const readCzNsSbirkaSitemapIndex = (xml: string): string[] => {
  const sitemaps: { url: string; number: number }[] = [];
  for (const block of elementsOf(xml, "sitemap")) {
    const url = fieldOf(block, "loc");
    const number =
      url === undefined
        ? undefined
        : COLLECTION_SITEMAP_PATTERN.exec(url)?.groups?.["number"];
    if (url !== undefined && number !== undefined) {
      sitemaps.push({
        url,
        number: number === "" ? 1 : integerOf(number),
      });
    }
  }
  return sitemaps
    .toSorted((left, right) => left.number - right.number)
    .map(({ url }) => url);
};

/**
 * Every entry one collection sitemap lists. A listed URL that is not an
 * entry, or an entry without a readable `lastmod`, is not a sitemap this
 * reader knows, and the page fails rather than skip it.
 */
export const readCzNsSbirkaSitemap = (
  xml: string,
  url: string,
): Result<CzNsSbirkaSitemapEntry[], AdapterFetchError> => {
  const entries: CzNsSbirkaSitemapEntry[] = [];
  for (const block of elementsOf(xml, "url")) {
    const loc = fieldOf(block, "loc");
    const lastmod = fieldOf(block, "lastmod");
    const postId = loc === undefined ? undefined : postIdOfUrl(loc);
    if (
      postId === undefined ||
      lastmod === undefined ||
      instantOf(lastmod) === null
    ) {
      return Result.err(
        listingError(
          `Collection sitemap ${url} lists an entry this reader cannot place: ${loc ?? "no address"}`,
          null,
        ),
      );
    }
    entries.push({ postId, lastmod });
  }
  return Result.ok(entries);
};

/** Walk order: `lastmod`, then post id, as the publisher orders its sitemaps. */
const compareEntries = (
  left: CzNsSbirkaSitemapEntry,
  right: CzNsSbirkaSitemapEntry,
): number => {
  const byTime = Temporal.Instant.compare(
    Temporal.Instant.from(left.lastmod),
    Temporal.Instant.from(right.lastmod),
  );
  return byTime === 0
    ? integerOf(left.postId) - integerOf(right.postId)
    : byTime;
};

// ── Cursor ───────────────────────────────────────────────

const CURSOR_VERSION = 1;

const cursorSchema = v.strictObject({
  version: v.literal(CURSOR_VERSION),
  /** Position among the collection sitemaps the index lists. */
  sitemap: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The last entry read; null before the first. */
  after: v.nullable(
    v.strictObject({
      postId: v.pipe(v.string(), v.regex(POST_ID_PATTERN)),
      lastmod: v.pipe(
        v.string(),
        v.check((value) => instantOf(value) !== null),
      ),
    }),
  ),
});

export type CzNsSbirkaCursor = v.InferOutput<typeof cursorSchema>;

export const encodeCzNsSbirkaCursor = (cursor: CzNsSbirkaCursor): string =>
  JSON.stringify(cursor);

const START_CURSOR: CzNsSbirkaCursor = {
  version: CURSOR_VERSION,
  sitemap: 0,
  after: null,
};

const parseCursor = (
  cursor: string | null,
): Result<CzNsSbirkaCursor, AdapterFetchError> => {
  if (cursor === null) {
    return Result.ok(START_CURSOR);
  }
  const parsed = v.safeParse(
    cursorSchema,
    Result.try((): unknown => JSON.parse(cursor)).unwrapOr(null),
  );
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        listingError(
          "Collection cursor is not one this adapter writes",
          cursor,
        ),
      );
};

const isAfter = (
  entry: CzNsSbirkaSitemapEntry,
  after: CzNsSbirkaCursor["after"],
): boolean => after === null || compareEntries(entry, after) > 0;

type PendingEntries = {
  position: number;
  sitemapUrl: string;
  pending: CzNsSbirkaSitemapEntry[];
};

/**
 * The entries after the cursor, from the sitemap it sits in, or from the
 * next ones once that one lists nothing after it.
 */
const pendingEntries = async (
  cursor: CzNsSbirkaCursor,
  cursorText: string | null,
  signal: AbortSignal | undefined,
): Promise<Result<PendingEntries, AdapterFetchError>> => {
  const index = await readListing(SITEMAP_INDEX_URL, cursorText, signal);
  if (Result.isError(index)) {
    return Result.err(index.error);
  }
  const sitemaps =
    index.value.type === "present"
      ? readCzNsSbirkaSitemapIndex(index.value.body)
      : [];
  const lastPosition = sitemaps.length - 1;
  if (lastPosition < 0) {
    return Result.err(
      listingError(
        "Collection sitemap index lists no collection sitemap",
        cursorText,
      ),
    );
  }
  for (
    let position = Math.min(cursor.sitemap, lastPosition);
    position <= lastPosition;
    position += 1
  ) {
    const sitemapUrl =
      sitemaps[position] ?? panic("sitemap position out of range");
    const sitemap = await readListing(sitemapUrl, cursorText, signal);
    if (Result.isError(sitemap)) {
      return Result.err(sitemap.error);
    }
    if (sitemap.value.type === "absent") {
      return Result.err(
        listingError(
          `Collection sitemap ${sitemapUrl} is listed and not served`,
          cursorText,
        ),
      );
    }
    const listed = readCzNsSbirkaSitemap(sitemap.value.body, sitemapUrl);
    if (Result.isError(listed)) {
      return Result.err(listed.error);
    }
    const pending = listed.value
      .filter((entry) => isAfter(entry, cursor.after))
      .toSorted(compareEntries);
    if (pending.length > 0 || position === lastPosition) {
      return Result.ok({ position, sitemapUrl, pending });
    }
  }
  return panic("the sitemap walk ended past the last sitemap");
};

/**
 * One page of the walk: the next entries after the cursor, read and built.
 *
 * The page reads the sitemap index, then the sitemap the cursor sits in,
 * moving to the next only once this one lists nothing after the cursor. At
 * the newest entry the page asks for the index and the last sitemap and
 * nothing else.
 */
const crawlPage = async (
  cursorText: string | null,
  signal: AbortSignal | undefined,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const cursor = parseCursor(cursorText);
  if (Result.isError(cursor)) {
    return Result.err(cursor.error);
  }
  const listed = await pendingEntries(cursor.value, cursorText, signal);
  if (Result.isError(listed)) {
    return Result.err(listed.error);
  }
  const { position, sitemapUrl, pending } = listed.value;
  const batch = pending.slice(0, CZ_NS_SBIRKA_PAGE_SIZE);
  const decisions: IngestionResult[] = [];
  let failed = 0;
  for (const entry of batch) {
    const read = await readCzNsSbirkaEntry(entry.postId, cursorText, signal);
    if (Result.isError(read)) {
      return Result.err(read.error);
    }
    switch (read.value.type) {
      case "built":
        decisions.push(read.value.decision);
        break;
      case "build-failed":
        failed += 1;
        decisions.push(read.value.decision);
        break;
      case "unkeyable":
        failed += 1;
        logger.warn("case_law.ingestion.cz_ns_sbirka_entry_unbuilt", {
          adapterKey: KEY,
          sourceDocumentId: entry.postId,
          outcome: read.value.type,
        });
        break;
      case "unread":
        // A withdrawn entry (listed, then 404 or 410) has nothing to store,
        // and the next sitemap read no longer lists it. A refusal of this
        // one page is counted; the reconciliation's walk meets it again.
        if (read.value.read.type === "refused") {
          failed += 1;
          logger.warn("case_law.ingestion.cz_ns_sbirka_entry_unbuilt", {
            adapterKey: KEY,
            sourceDocumentId: entry.postId,
            outcome: read.value.read.type,
          });
        }
        break;
      default:
        read.value satisfies never;
        return panic(
          `Unhandled collection entry: ${JSON.stringify(read.value)}`,
        );
    }
  }
  const last = batch.at(-1);
  return Result.ok({
    decisions,
    itemBuildFailures: { type: "item_build_failed", count: failed },
    publisherRequest: PUBLISHER_REQUEST.ANSWERED,
    nextCursor: encodeCzNsSbirkaCursor({
      version: CURSOR_VERSION,
      sitemap: position,
      after:
        last === undefined
          ? cursor.value.after
          : { postId: last.postId, lastmod: last.lastmod },
    }),
    sourceUrl: sitemapUrl,
  });
};

// ── Count ────────────────────────────────────────────────

/** Every entry the collection sitemaps list; null where one is not served. */
const countEntries = async (
  signal: AbortSignal,
): Promise<Result<number | null, AdapterFetchError>> => {
  const index = await readListing(SITEMAP_INDEX_URL, null, signal);
  if (Result.isError(index) || index.value.type === "absent") {
    return Result.isError(index) ? Result.err(index.error) : Result.ok(null);
  }
  let total = 0;
  for (const url of readCzNsSbirkaSitemapIndex(index.value.body)) {
    const sitemap = await readListing(url, null, signal);
    if (Result.isError(sitemap)) {
      return Result.err(sitemap.error);
    }
    if (sitemap.value.type === "absent") {
      return Result.ok(null);
    }
    const entries = readCzNsSbirkaSitemap(sitemap.value.body, url);
    if (Result.isError(entries)) {
      return Result.err(entries.error);
    }
    total += entries.value.length;
  }
  return Result.ok(total);
};

const totalCount = async (signal: AbortSignal): Promise<SourceTotalCount> => {
  const counted = await Result.tryPromise({
    try: async () => await countEntries(signal),
    catch: (error) => error,
  });
  if (Result.isError(counted)) {
    return { type: "probe-failed", errorTag: errorTag(counted.error) };
  }
  if (Result.isError(counted.value)) {
    return { type: "probe-failed", errorTag: errorTag(counted.value.error) };
  }
  return counted.value.value === null
    ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS)
    : sourceTotalRead(counted.value.value);
};

// ── Reconciliation ───────────────────────────────────────

/** The first collection year the archive lists under a year of its own. */
const FIRST_YEAR = 1956;
const YEAR_SLICE = /^\d{4}$/u;

/**
 * Slices near the tip re-walked on a fast cadence. The contract counts
 * slices: the current collection year, and the last one, which still gains
 * entries early in a year as its final issues are published.
 */
const TIP_WINDOW_SLICES = 2;

const yearOfSlice = (slice: string): number =>
  YEAR_SLICE.test(slice)
    ? integerOf(slice)
    : panic(`cz-ns-sbirka slice is not a collection year: ${slice}`);

const sliceOf = (now: Date): string =>
  String(
    Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
      "UTC",
    ).year,
  );

const nextSlice = (slice: string): string | null => {
  if (slice === CZ_NS_SBIRKA_VAZNY_SLICE) {
    return String(FIRST_YEAR);
  }
  const next = yearOfSlice(slice) + 1;
  return next > Temporal.Now.plainDateISO("UTC").year ? null : String(next);
};

const previousSlice = (slice: string): string | null => {
  if (slice === CZ_NS_SBIRKA_VAZNY_SLICE) {
    return null;
  }
  const previous = yearOfSlice(slice) - 1;
  return previous < FIRST_YEAR ? CZ_NS_SBIRKA_VAZNY_SLICE : String(previous);
};

/** The archive page listing `slice`, `page` counted from 0. */
export const czNsSbirkaSliceUrl = (slice: string, page: number): string => {
  const term =
    slice === CZ_NS_SBIRKA_VAZNY_SLICE
      ? "vazny"
      : `rok-${String(yearOfSlice(slice))}`;
  const base = `${ORIGIN}/year-collection/${term}/`;
  return page === 0 ? base : `${base}strana/${String(page + 1)}/`;
};

const PAGE_NUMBER = /^\d{1,4}$/u;

/** The entries one archive page lists, and how many pages the slice has. */
export const readCzNsSbirkaArchivePage = (
  html: string,
): { postIds: (string | undefined)[]; lastPage: number } => {
  const $ = load(html);
  const postIds = $("article.listing-item h2 a")
    .toArray()
    .map((link) => postIdOfUrl($(link).attr("href") ?? ""));
  const pages = $(".pagination .page-numbers")
    .toArray()
    .flatMap((node) => {
      const text = visibleHtmlText($(node)).trim();
      const number = PAGE_NUMBER.test(text) ? integerOf(text) : undefined;
      return number === undefined ? [] : [number];
    });
  return { postIds, lastPage: Math.max(1, ...pages) };
};

const isListingRow = (value: unknown): value is { postId: string } =>
  isRecord(value) &&
  typeof value["postId"] === "string" &&
  POST_ID_PATTERN.test(value["postId"]);

/**
 * One archive page of a slice. A slice the archive has no term for lists
 * nothing; a later page that vanished mid-walk, or a page listing no entry,
 * is not an answer and fails the slice.
 */
const listSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const url = czNsSbirkaSliceUrl(slice, page);
  const read = await readListing(url, slice, signal);
  if (Result.isError(read)) {
    return await Promise.reject(read.error);
  }
  if (read.value.type === "absent") {
    return page === 0
      ? { items: [], totalPages: 0 }
      : await Promise.reject(
          listingError(`Collection archive ${url} is no longer served`, slice),
        );
  }
  const { postIds, lastPage } = readCzNsSbirkaArchivePage(read.value.body);
  if (postIds.length === 0) {
    return await Promise.reject(
      listingError(`Collection archive ${url} lists no entry`, slice),
    );
  }
  return {
    items: postIds.map((postId) =>
      postId === undefined
        ? { identity: { type: "unidentifiable" }, payload: null }
        : {
            identity: { type: "document", sourceDocumentId: postId },
            payload: { postId },
          },
    ),
    totalPages: lastPage,
  };
};

const buildFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isListingRow(payload)) {
    return { type: "unkeyable" };
  }
  const read = await readCzNsSbirkaEntry(payload.postId, null, signal);
  if (Result.isError(read)) {
    return await Promise.reject(read.error);
  }
  switch (read.value.type) {
    case "built":
    case "build-failed":
      return { type: "built", decision: read.value.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    case "unread":
      return { type: "detail-unavailable" };
    default:
      read.value satisfies never;
      return panic(`Unhandled collection entry: ${JSON.stringify(read.value)}`);
  }
};

// ── Replay ───────────────────────────────────────────────

const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: (listing) =>
      isListingRow(listing) ? listing.postId : undefined,
  });
  if (read.type === "rejected") {
    return read;
  }
  const detailHtml = read.parts[RAW_PART.DETAIL];
  const postId = stored.sourceDocumentId;
  if (detailHtml === undefined || postId === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: "the stored payload holds no detail page",
    };
  }
  const decision = buildCzNsSbirkaDecision({ postId, detailHtml });
  return decision === null
    ? {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
        detail: "the stored detail page states no docket",
      }
    : { type: "parsed", result: decision };
};

// ── Source fields and surfaces ───────────────────────────

/**
 * Every field the detail page labels in either of its tables, under the
 * publisher's own label, and the heading of its text row. The heading (`<h1>`), the breadcrumb and the
 * keyword chips are the page's renderings of what these rows state; the
 * entry keeps the heading whole and reads the others only as fallbacks.
 */
const SOURCE_FIELDS = [
  "Právní věta",
  "Anotace",
  "Soud",
  "Datum rozhodnutí",
  "Spisová značka",
  "Číslo rozhodnutí",
  "Rok",
  "Sešit",
  "Typ rozhodnutí",
  "Heslo",
  "Předpisy",
  "Druh",
  "Dotčená rozhodnutí",
  "Ústavní stížnost",
  CZ_NS_SBIRKA_TEXT_HEADING,
] as const;

type CzNsSbirkaPublisherRecord = Readonly<
  Record<(typeof SOURCE_FIELDS)[number], unknown>
>;

const entryField = (path: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: {
    type: "metadata",
    key: CZ_NS_COLLECTION_METADATA_KEY,
    path: [path],
  },
});

const CZ_NS_SBIRKA_SOURCE_FIELDS = {
  "Právní věta": {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  Anotace: {
    disposition: "stored",
    target: { type: "textField", key: "abstract" },
  },
  /**
   * Stored as the row's court through `czDecisionCourt`, where the entry's
   * ECLI names the court; the page's own spelling stays in the entry.
   */
  Soud: { disposition: "stored", target: { type: "result", key: "court" } },
  "Datum rozhodnutí": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  "Spisová značka": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "Číslo rozhodnutí": entryField("number"),
  Rok: entryField("year"),
  Sešit: entryField("issue"),
  "Typ rozhodnutí": {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  Heslo: entryField("keywords"),
  Předpisy: entryField("citedProvisions"),
  Druh: entryField("kind"),
  "Dotčená rozhodnutí": entryField("affectedDecisions"),
  "Ústavní stížnost": entryField("constitutionalComplaint"),
  /** The row the collection's text sits in; the text is the document. */
  [CZ_NS_SBIRKA_TEXT_HEADING]: {
    disposition: "stored",
    target: { type: "document" },
  },
} as const satisfies Record<
  keyof CzNsSbirkaPublisherRecord,
  SourceFieldDisposition
>;

const listSourceFields = (parts: SourceRawParts): readonly string[] => {
  const html = parts[RAW_PART.DETAIL];
  if (html === undefined) {
    return [];
  }
  const page = readCzNsSbirkaPage(html);
  return [
    ...page.fields.keys(),
    ...(page.textHeading === undefined ? [] : [page.textHeading]),
  ];
};

const SOURCE_SURFACES = [
  "sitemaps",
  "listing",
  "detail",
  "year-archive",
  "document-pdf",
  "document-epub",
] as const;

const CZ_NS_SBIRKA_SOURCE_SURFACES = {
  surfaces: {
    sitemaps: excludedSourceSurface(
      "corpus-wide addresses with a modification time each, read for the walk; the entry's post id is kept as the listing part",
    ),
    listing: storedSourceSurface(RAW_PART.LISTING),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    "year-archive": excludedSourceSurface(
      "the collection-year archive restates the heading, keywords and headnote the detail page states; read for reconciliation identities only",
    ),
    "document-pdf": excludedSourceSurface(
      "a PDF rendering of the fields and text the detail page states; its address is kept in the collection entry",
    ),
    "document-epub": excludedSourceSurface(
      "an ePUB rendering of the fields and text the detail page states; its address is kept in the collection entry",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Adapter ──────────────────────────────────────────────

/** One page of the walk; exported for tests that drive it with a fixture. */
export const czNsSbirkaFetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
) =>
  (
    await Result.tryPromise({
      try: async () => await crawlPage(cursor, signal),
      catch: adapterCatch(KEY, cursor),
    })
  ).andThen((page) => page);

export const czNsSbirkaAdapter = defineSourceAdapter({
  key: KEY,
  documentStage: "inline",
  language: DEFAULT_LANGUAGE,
  minRequestIntervalMs: publisherRequestIntervalMs(KEY),
  pageTimeoutMs: PAGE_TIMEOUT_MS,
  maxSyncPages: MAX_SYNC_PAGES,
  sourceSurfaces: CZ_NS_SBIRKA_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: CZ_NS_SBIRKA_SOURCE_FIELDS,
    listSourceFields,
  },
  fetchPage: async (cursor, _config, signal) =>
    await czNsSbirkaFetchPage(cursor, signal),
  reparseStoredRaw,
  getTotalCount: totalCount,
  reconciliation: {
    // The post id is the whole listing payload: an archive page states
    // nothing else the stored entry is read from.
    revisionOf: (payload) =>
      isListingRow(payload) ? { postId: payload.postId } : null,
    firstSlice: CZ_NS_SBIRKA_VAZNY_SLICE,
    sliceOf,
    nextSlice,
    previousSlice,
    tipWindowDays: TIP_WINDOW_SLICES,
    listSlicePage,
    buildDecision: buildFromPayload,
  },
});
