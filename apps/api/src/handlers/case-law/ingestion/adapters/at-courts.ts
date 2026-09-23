import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  AT_RIS_APPLICATIONS,
  AT_RIS_PART,
  atRisFieldInventory,
  atRisStoredValues,
} from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
import type { AtRisApplicationProfile } from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
import { atRisSourceSurfaces } from "@/api/handlers/case-law/ingestion/adapters/at-ris-source-surfaces";
import {
  AT_RIS_DOCUMENT_ORIGINS,
  fetchAtRisWithRetry,
} from "@/api/handlers/case-law/ingestion/adapters/at-ris-throttle";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import type { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import type { RisDocumentSections } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
  sourceTextField,
} from "@/api/lib/case-law/decision-text";
import type { DecisionTextFields } from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";

const API_URL = "https://data.bka.gv.at/ris/api/v2.6/Judikatur";
const LANGUAGE = "de";
const PAGE_SIZE = 100;
/** Read off the policy map, so the pacing this adapter states and the gate
 * that enforces it cannot drift apart. */
const REQUEST_INTERVAL_MS = publisherRequestIntervalMs(ADAPTER_KEYS.AT_COURTS);
const MIN_DOCUMENT_LENGTH = 100;
const START_DIGEST = "start";
const FOREIGN_ORGAN_PREFIX = "AUSL";
const TIP_WINDOW_MONTHS = 3;
const MAX_SLICE_PAGES = 200;
// The runner admits two adapter cycles by default. At 100 details per RIS page,
// the shared five-second publisher gate can therefore hold a healthy page for
// almost 17 minutes. Keep the page budget above that contention envelope and
// the cycle budget above the page budget, while remaining below the runner's
// 45-minute hard deadline.
const PAGE_TIMEOUT_MS = 25 * 60_000;
const CYCLE_TIMEOUT_MS = 30 * 60_000;

const CURSOR_PHASE = {
  COLLECT: "collect",
  VERIFY: "verify",
} as const;

type CrawlCursorBase = {
  slice: string;
  page: number;
  digest: string;
  foreign: number;
  collected: number;
  total: number | null;
};

type CrawlCursor =
  | (CrawlCursorBase & {
      phase: typeof CURSOR_PHASE.COLLECT;
      expectedDigest: null;
      expectedForeign: null;
    })
  | (CrawlCursorBase & {
      phase: typeof CURSOR_PHASE.VERIFY;
      expectedDigest: string;
      expectedForeign: number;
    });

type RisListingItem = Record<string, unknown>;

type RisListingPage = {
  items: RisListingItem[];
  pageNumber: number;
  pageSize: number;
  total: number;
};

type DecisionDateAdapterKey = {
  [
    TKey in AdapterKey
  ]: (typeof ADAPTER_MANIFESTS)[TKey]["dateRange"]["type"] extends "decision-date"
    ? TKey
    : never;
}[AdapterKey];

type AtRisAdapterKey = Exclude<
  Extract<DecisionDateAdapterKey, `at-${string}`>,
  typeof ADAPTER_KEYS.AT_FINDOK
>;

export type AtRisSourceDefinition = {
  application: string;
  excludeForeignCourts: boolean;
  firstSlice: string;
  key: AtRisAdapterKey;
  lastSlice?: string | undefined;
};

export type AtRisDependencies = {
  now: () => Date;
  request: typeof fetchWithRetry;
  sleep: (ms: number) => Promise<void>;
};

type AtRisSourceDeclaration<TKey extends AtRisAdapterKey> = {
  application: string;
  excludeForeignCourts: boolean;
  key: TKey;
};

export const defineAtRisSource = <const TKey extends AtRisAdapterKey>({
  application,
  excludeForeignCourts,
  key,
}: AtRisSourceDeclaration<TKey>): AtRisSourceDefinition & {
  readonly key: TKey;
} => {
  const { dateRange } = ADAPTER_MANIFESTS[key];
  const firstSlice = dateRange.fromInclusive.slice(0, 7);
  switch (dateRange.through.type) {
    case "open":
      return { application, excludeForeignCourts, firstSlice, key };
    case "inclusive":
      return {
        application,
        excludeForeignCourts,
        firstSlice,
        key,
        lastSlice: dateRange.through.date.slice(0, 7),
      };
    default: {
      dateRange.through satisfies never;
      return panic(`Unhandled date-range end for ${key}`);
    }
  }
};

export const AT_COURTS_SOURCE = defineAtRisSource({
  application: "Justiz",
  excludeForeignCourts: true,
  key: ADAPTER_KEYS.AT_COURTS,
});

const DEFAULT_DEPENDENCIES: AtRisDependencies = {
  now: () => new Date(),
  request: fetchAtRisWithRetry,
  sleep: Bun.sleep,
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const nestedRecord = (
  value: unknown,
  ...keys: readonly string[]
): Record<string, unknown> | undefined => {
  let current = asRecord(value);
  for (const key of keys) {
    current = asRecord(current?.[key]);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const stringList = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
};

const itemValues = (value: unknown): string[] =>
  stringList(asRecord(value)?.["item"]);

const monthParts = (
  slice: string,
): { year: number; month: number } | undefined => {
  const match = /^(?<year>\d{4})-(?<month>\d{2})$/u.exec(slice);
  const year = Number(match?.groups?.["year"]);
  const month = Number(match?.groups?.["month"]);
  return Number.isInteger(year) && month >= 1 && month <= 12
    ? { year, month }
    : undefined;
};

const formatMonth = (year: number, month: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

export const atRisNextMonth = (slice: string): string | null => {
  const parts = monthParts(slice);
  if (parts === undefined) {
    return null;
  }
  return parts.month === 12
    ? formatMonth(parts.year + 1, 1)
    : formatMonth(parts.year, parts.month + 1);
};

const previousMonth = (firstSlice: string, slice: string): string | null => {
  const parts = monthParts(slice);
  if (parts === undefined || slice <= firstSlice) {
    return null;
  }
  const previous =
    parts.month === 1
      ? formatMonth(parts.year - 1, 12)
      : formatMonth(parts.year, parts.month - 1);
  return previous < firstSlice ? null : previous;
};

export const atRisPreviousMonth = (slice: string): string | null =>
  previousMonth(AT_COURTS_SOURCE.firstSlice, slice);

export const atRisMonthOf = (date: Date): string => {
  const day = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO("UTC");
  return formatMonth(day.year, day.month);
};

export const atRisLastCompleteMonth = (date: Date): string =>
  previousMonth("0001-01", atRisMonthOf(date)) ?? "0001-01";

const tipSlice = (source: AtRisSourceDefinition, now: Date): string => {
  const complete = atRisLastCompleteMonth(now);
  return source.lastSlice !== undefined && source.lastSlice < complete
    ? source.lastSlice
    : complete;
};

const monthDateRange = (
  slice: string,
): { from: string; to: string } | undefined => {
  const parts = monthParts(slice);
  if (parts === undefined) {
    return undefined;
  }
  const lastDay = String(
    Temporal.PlainYearMonth.from(parts).daysInMonth,
  ).padStart(2, "0");
  return {
    from: `${slice}-01`,
    to: `${slice}-${lastDay}`,
  };
};

const cursorForSlice = (slice: string): CrawlCursor => ({
  slice,
  phase: CURSOR_PHASE.COLLECT,
  page: 1,
  digest: START_DIGEST,
  foreign: 0,
  collected: 0,
  total: null,
  expectedDigest: null,
  expectedForeign: null,
});

const encodeCursor = ({
  slice,
  phase,
  page,
  digest,
  foreign,
  collected,
  total,
  expectedDigest,
  expectedForeign,
}: CrawlCursor): string =>
  [
    slice,
    phase,
    page,
    digest,
    foreign,
    collected,
    total ?? "unset",
    expectedDigest ?? "unset",
    expectedForeign ?? "unset",
  ].join("|");

const parseCount = (value: string): number | undefined => {
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
};

const parseNullableCount = (
  value: string | undefined,
): number | null | undefined => {
  if (value === "unset") {
    return null;
  }
  return value === undefined ? undefined : parseCount(value);
};

const decodeCursor = (
  cursor: string | null,
  now: Date,
  source: AtRisSourceDefinition,
): CrawlCursor | undefined => {
  const lastCompleteMonth = tipSlice(source, now);
  if (cursor === null) {
    return cursorForSlice(lastCompleteMonth);
  }
  const [
    slice,
    phase,
    rawPage,
    digest,
    rawForeign,
    rawCollected,
    rawTotal,
    rawExpectedDigest,
    rawExpectedForeign,
  ] = cursor.split("|");
  const page = rawPage === undefined ? undefined : parseCount(rawPage);
  const foreign = rawForeign === undefined ? undefined : parseCount(rawForeign);
  const collected =
    rawCollected === undefined ? undefined : parseCount(rawCollected);
  const total = parseNullableCount(rawTotal);
  const expectedDigest =
    rawExpectedDigest === "unset" ? null : rawExpectedDigest;
  const expectedForeign = parseNullableCount(rawExpectedForeign);
  if (
    slice === undefined ||
    monthParts(slice) === undefined ||
    slice < source.firstSlice ||
    slice > lastCompleteMonth ||
    (phase !== CURSOR_PHASE.COLLECT && phase !== CURSOR_PHASE.VERIFY) ||
    page === undefined ||
    page < 1 ||
    digest === undefined ||
    digest === "" ||
    foreign === undefined ||
    collected === undefined ||
    total === undefined ||
    expectedDigest === undefined ||
    expectedForeign === undefined
  ) {
    return undefined;
  }
  const base = {
    slice,
    page,
    digest,
    foreign,
    collected,
    total,
  };
  if (phase === CURSOR_PHASE.COLLECT) {
    return expectedDigest === null && expectedForeign === null
      ? {
          ...base,
          phase,
          expectedDigest,
          expectedForeign,
        }
      : undefined;
  }
  return expectedDigest !== null && expectedForeign !== null
    ? {
        ...base,
        phase,
        expectedDigest,
        expectedForeign,
      }
    : undefined;
};

const listingQuery = (
  source: AtRisSourceDefinition,
  slice: string | undefined,
  page: number,
  // RIS's `Gericht` filter token, not a court's name: `AUSL` selects the
  // foreign-court rows this source excludes.
  courtFilter?: string,
): string => {
  const params = new URLSearchParams({
    Applikation: source.application,
    "Dokumenttyp.SucheInEntscheidungstexten": "true",
    DokumenteProSeite: "OneHundred",
    Seitennummer: String(page),
    "Sortierung.SortDirection": "Ascending",
    "Sortierung.SortedByColumn": "Datum",
  });
  if (slice !== undefined) {
    const range = monthDateRange(slice);
    if (range === undefined) {
      panic(`Invalid RIS month slice: ${slice}`);
    }
    params.set("EntscheidungsdatumVon", range.from);
    params.set("EntscheidungsdatumBis", range.to);
  }
  if (courtFilter !== undefined) {
    params.set("Gericht", courtFilter);
  }
  return `${API_URL}?${params.toString()}`;
};

const listingItems = (value: unknown): RisListingItem[] | undefined => {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.every(isRecord) ? value : undefined;
  }
  return isRecord(value) ? [value] : undefined;
};

const parseListingPage = (value: unknown): RisListingPage | undefined => {
  const results = nestedRecord(value, "OgdSearchResult", "OgdDocumentResults");
  const hits = asRecord(results?.["Hits"]);
  const rawTotal = optionalString(hits?.["#text"]);
  const total = rawTotal === undefined ? undefined : parseCount(rawTotal);
  const rawPageNumber = optionalString(hits?.["@pageNumber"]);
  const pageNumber =
    rawPageNumber === undefined ? undefined : parseCount(rawPageNumber);
  const rawPageSize = optionalString(hits?.["@pageSize"]);
  const pageSize =
    rawPageSize === undefined ? undefined : parseCount(rawPageSize);
  const items = listingItems(results?.["OgdDocumentReference"]);
  if (
    total === undefined ||
    pageNumber === undefined ||
    pageNumber < 1 ||
    pageSize === undefined ||
    pageSize < 1 ||
    items === undefined ||
    items.some((item) => nestedRecord(item, "Data", "Metadaten") === undefined)
  ) {
    return undefined;
  }
  if (
    (total === 0 && items.length !== 0) ||
    (total > 0 && items.length === 0)
  ) {
    return undefined;
  }
  return { items, pageNumber, pageSize, total };
};

const rawSourceDocumentIdOf = (item: RisListingItem): string | undefined =>
  optionalString(nestedRecord(item, "Data", "Metadaten", "Technisch")?.["ID"]);

const sourceDocumentIdOf = (item: RisListingItem): string | undefined => {
  const id = rawSourceDocumentIdOf(item);
  return id !== undefined && isPersistableSourceDocumentId(id) ? id : undefined;
};

const organOf = (item: RisListingItem): string | undefined =>
  optionalString(
    nestedRecord(item, "Data", "Metadaten", "Technisch")?.["Organ"],
  );

const isForeignItem = (item: RisListingItem): boolean =>
  organOf(item)?.startsWith(FOREIGN_ORGAN_PREFIX) ?? false;

const isExcludedItem = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
): boolean => source.excludeForeignCourts && isForeignItem(item);

/**
 * One document the publisher lists for a decision, in every format it serves.
 *
 * A decision with an embedded image is listed as several of these — the main
 * document and one reference per image — so the element is read as the list
 * the schema declares rather than as the single record it happens to be for a
 * decision that embeds nothing.
 */
type RisContentReference = {
  contentType: string | undefined;
  name: string | undefined;
  formats: { dataType: string; url: string }[];
};

const contentReferences = (
  item: RisListingItem,
): readonly RisContentReference[] => {
  const raw = nestedRecord(item, "Data", "Dokumentliste")?.["ContentReference"];
  const listed = Array.isArray(raw) ? raw : [raw];
  const references: RisContentReference[] = [];
  for (const entry of listed) {
    const record = asRecord(entry);
    if (record === undefined) {
      continue;
    }
    const urls = asRecord(record["Urls"])?.["ContentUrl"];
    const formats: { dataType: string; url: string }[] = [];
    for (const format of Array.isArray(urls) ? urls : [urls]) {
      const dataType = optionalString(asRecord(format)?.["DataType"]);
      const url = optionalString(asRecord(format)?.["Url"]);
      if (dataType !== undefined && url !== undefined) {
        formats.push({ dataType, url });
      }
    }
    references.push({
      contentType: optionalString(record["ContentType"]),
      name: optionalString(record["Name"]),
      formats,
    });
  }
  return references;
};

const MAIN_DOCUMENT_CONTENT_TYPE = "MainDocument";

/**
 * The formats the decision's own document is listed in.
 *
 * A reference without a content type counts as the main document: the element
 * is mandatory in the schema, and a payload that omits it lists one document.
 */
const mainDocumentFormats = (item: RisListingItem): Record<string, string> => {
  const urls: Record<string, string> = {};
  for (const reference of contentReferences(item)) {
    if (
      reference.contentType !== undefined &&
      reference.contentType !== MAIN_DOCUMENT_CONTENT_TYPE
    ) {
      continue;
    }
    for (const { dataType, url } of reference.formats) {
      urls[dataType] ??= url;
    }
  }
  return urls;
};

const parsedUrl = (value: string): URL | null =>
  Result.try({
    try: () => new URL(value),
    catch: () => null,
  }).unwrapOr(null);

/**
 * The address the publisher lists for one format of this decision's document.
 *
 * The listed URL is what the crawl follows — reconstructing it is what stopped
 * every Austrian document being fetched when the publisher moved them to
 * another of its hosts. What is still checked is that the address is one of
 * this publisher's document origins and that its path is the one this
 * document number implies, so a listed address can name a different host or a
 * different document and be refused rather than followed.
 */
const listedDocumentUrl = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
  sourceDocumentId: string,
  dataType: "Html" | "Xml",
  extension: "html" | "xml",
): string | undefined => {
  const listed = mainDocumentFormats(item)[dataType];
  if (listed === undefined) {
    return undefined;
  }
  const url = parsedUrl(listed);
  if (url === null) {
    return undefined;
  }
  const path = `/Dokumente/${source.application}/${sourceDocumentId}/${sourceDocumentId}.${extension}`;
  return AT_RIS_DOCUMENT_ORIGINS.some((origin) => origin === url.origin) &&
    decodeURIComponent(url.pathname) === path
    ? listed
    : undefined;
};

/**
 * The field profile of each tribunal this module builds an adapter for.
 *
 * Checked total here rather than where the profiles are written: the union is
 * this module's, so an application registered without a profile fails to
 * compile instead of reaching a crawl with nothing declared about its fields.
 */
const AT_RIS_PROFILES = AT_RIS_APPLICATIONS satisfies Record<
  AtRisAdapterKey,
  AtRisApplicationProfile
>;

const profileOf = (source: AtRisSourceDefinition): AtRisApplicationProfile =>
  AT_RIS_PROFILES[source.key];

/**
 * The publisher's two document kinds, as the row names them.
 *
 * A kind this publisher has not served before is kept as it spelled it: the
 * row then carries the publisher's own word rather than a silent default.
 */
const documentKindOf = (value: unknown): string | undefined => {
  const kind = optionalString(value);
  switch (kind) {
    case "Rechtssatz":
      return "headnote";
    case "Text":
      return "text";
    case undefined:
      return undefined;
    default:
      return kind;
  }
};

/**
 * The publisher writes its keywords as one line, separated by commas,
 * semicolons or line breaks depending on the application and the decade.
 */
const keywordList = (value: unknown): string[] =>
  (optionalString(value) ?? "")
    .split(/[,;\r\n]+/u)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== "");

const readDecisionMetadata = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
) => {
  const metadata = nestedRecord(item, "Data", "Metadaten");
  const technical = asRecord(metadata?.["Technisch"]);
  const general = asRecord(metadata?.["Allgemein"]);
  const judicature = asRecord(metadata?.["Judikatur"]);
  const sourceMetadata = asRecord(judicature?.[source.application]);
  const caseNumbers = itemValues(judicature?.["Geschaeftszahl"]);
  const decisionTexts = asRecord(sourceMetadata?.["Entscheidungstexte"])?.[
    "item"
  ];
  const firstDecisionText = asRecord(
    Array.isArray(decisionTexts) ? decisionTexts.at(0) : decisionTexts,
  );
  const decisionType =
    optionalString(sourceMetadata?.["Entscheidungsart"]) ??
    optionalString(firstDecisionText?.["Entscheidungsart"]);
  return {
    metadata,
    general,
    judicature,
    sourceMetadata,
    caseNumbers,
    decisionType: decisionType?.toLocaleLowerCase("de-AT"),
    caseNumber: caseNumbers.at(0),
    court:
      optionalString(sourceMetadata?.["Gericht"]) ??
      optionalString(sourceMetadata?.["EntscheidendeBehoerde"]) ??
      optionalString(technical?.["Organ"]),
    decisionDate: optionalString(judicature?.["Entscheidungsdatum"]),
    ecli: optionalString(judicature?.["EuropeanCaseLawIdentifier"]),
    sourceUrl: optionalString(general?.["DokumentUrl"]),
    published: optionalString(general?.["Veroeffentlicht"]),
    modified: optionalString(general?.["Geaendert"]),
    statutes: itemValues(judicature?.["Normen"]),
    legalAreas: itemValues(sourceMetadata?.["Rechtsgebiete"]),
    headnoteNumbers: itemValues(sourceMetadata?.["Rechtssatznummern"]),
    organ: optionalString(technical?.["Organ"]),
    submitter: optionalString(technical?.["Einbringer"]),
    documentKind: documentKindOf(judicature?.["Dokumenttyp"]),
    keywords: keywordList(judicature?.["Schlagworte"]),
    decisionTextDocument: optionalString(judicature?.["EntscheidungstextUrl"]),
    documentParts: contentReferences(item),
    contentFormats: Object.keys(mainDocumentFormats(item)),
  };
};

type RisListingMetadata = ReturnType<typeof readDecisionMetadata>;

/**
 * What the row keeps of the fields this publisher states, beside the parsed
 * document.
 *
 * The branch and the printed sections are projected from the inventory's own
 * dispositions, so a field declared stored at a metadata key is written to
 * that key by construction rather than by a second hand-kept list.
 */
const decisionMetadata = (
  source: AtRisSourceDefinition,
  data: RisListingMetadata,
  sections: RisDocumentSections,
): Record<string, unknown> => ({
  ecli: data.ecli,
  court: data.court,
  decisionDate: data.decisionDate,
  decisionType: data.decisionType,
  statutes: data.statutes,
  additionalCaseNumbers: data.caseNumbers.slice(1),
  published: data.published,
  modified: data.modified,
  organ: data.organ,
  submitter: data.submitter,
  documentKind: data.documentKind,
  keywords: data.keywords,
  decisionTextDocument: data.decisionTextDocument,
  documentParts: data.documentParts,
  contentFormats: data.contentFormats,
  ...atRisStoredValues(profileOf(source), {
    branch: data.sourceMetadata,
    sections,
  }).metadataValues,
  sourceAttribution: "RIS, Austrian Federal Chancellery, CC BY 4.0",
});

/**
 * The texts the publisher itself wrote about the decision.
 *
 * Three of the four are real for this family: the constitutional court prints
 * a `Leitsatz` over its decisions, the administrative court a `Betreff`, and
 * a headnote document is a legal sentence from its first line to its last.
 * `headnote` stays absent, and so does any of the three an application does
 * not print — which is what the row claimed about all four of them until
 * these sections were read.
 */
const decisionTextFields = (
  source: AtRisSourceDefinition,
  data: RisListingMetadata,
  sections: RisDocumentSections,
): DecisionTextFields => {
  const stated = atRisStoredValues(profileOf(source), {
    branch: data.sourceMetadata,
    sections,
  }).textFields;
  return {
    ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    abstract: sourceTextField(source.key, stated.abstract),
    legalSentence: sourceTextField(source.key, stated.legalSentence),
    summary: sourceTextField(source.key, stated.summary),
  };
};

const quarantineSourceDocumentIds = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
): string[] => {
  const data = readDecisionMetadata(source, item);
  const rawId = rawSourceDocumentIdOf(item);
  const sibling =
    rawId !== undefined && rawId.length <= 1024
      ? /_(?<sibling>\d{3})$/u.exec(rawId)?.groups?.["sibling"]
      : undefined;
  const siblings = sibling === undefined ? [undefined] : [sibling, undefined];
  return siblings.map((stableSibling) => {
    const fingerprint = JSON.stringify({
      organ: organOf(item),
      caseNumbers: data.caseNumbers,
      court: data.court,
      decisionDate: data.decisionDate,
      decisionType: data.decisionType,
      statutes: data.statutes,
      legalAreas: data.legalAreas,
      headnoteNumbers: data.headnoteNumbers,
      sourceMetadata: data.sourceMetadata,
      sibling: stableSibling,
    });
    return `ris-quarantine:${hashContent(fingerprint)}`;
  });
};

type RisIdentity = {
  sourceDocumentId: string;
  sourceDocumentIdRepairAliases: readonly string[] | undefined;
  type: "publisher" | "quarantine";
};

const identityOf = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
): RisIdentity => {
  const quarantineIds = quarantineSourceDocumentIds(source, item);
  const quarantineId = quarantineIds[0];
  if (quarantineId === undefined) {
    panic("RIS quarantine identity construction failed");
  }
  const sourceDocumentId = sourceDocumentIdOf(item);
  return sourceDocumentId === undefined
    ? {
        sourceDocumentId: quarantineId,
        sourceDocumentIdRepairAliases: undefined,
        type: "quarantine",
      }
    : {
        sourceDocumentId,
        sourceDocumentIdRepairAliases: quarantineIds,
        type: "publisher",
      };
};

const itemDigest = (
  source: AtRisSourceDefinition,
  previous: string,
  items: readonly RisListingItem[],
): string =>
  hashContent(
    [
      previous,
      ...items.map((item) => identityOf(source, item).sourceDocumentId),
    ].join("\n"),
  );

const headnoteListingQuery = (
  source: AtRisSourceDefinition,
  caseNumber: string,
  decisionDate: string,
): string => {
  const params = new URLSearchParams({
    Applikation: source.application,
    "Dokumenttyp.SucheInRechtssaetzen": "true",
    Geschaeftszahl: caseNumber,
    EntscheidungsdatumVon: decisionDate,
    EntscheidungsdatumBis: decisionDate,
    DokumenteProSeite: "OneHundred",
    Seitennummer: "1",
    "Sortierung.SortDirection": "Ascending",
    "Sortierung.SortedByColumn": "Datum",
  });
  return `${API_URL}?${params.toString()}`;
};

/**
 * Whether a listed headnote is one of this decision's.
 *
 * The docket the query filters on is a full-text expression, so the answer is
 * narrowed to the rows that name this document: an administrative-court
 * headnote points at its decision through `EntscheidungstextUrl`, and the
 * other applications list the decisions adopting it in their own branch.
 */
const headnoteNamesDecision = (
  source: AtRisSourceDefinition,
  headnote: Record<string, unknown>,
  sourceDocumentId: string,
): boolean => {
  const judicature = nestedRecord(headnote, "Data", "Metadaten", "Judikatur");
  if (
    optionalString(judicature?.["EntscheidungstextUrl"])?.includes(
      sourceDocumentId,
    ) === true
  ) {
    return true;
  }
  const adopting = asRecord(
    asRecord(judicature?.[source.application])?.["Entscheidungstexte"],
  )?.["item"];
  const listed = Array.isArray(adopting) ? adopting : [adopting];
  return listed.some(
    (entry) =>
      optionalString(asRecord(entry)?.["Dokumentnummer"]) === sourceDocumentId,
  );
};

const headnoteSummary = (
  headnote: Record<string, unknown>,
): Record<string, unknown> => {
  const judicature = nestedRecord(headnote, "Data", "Metadaten", "Judikatur");
  return {
    sourceDocumentId: rawSourceDocumentIdOf(headnote),
    caseNumbers: itemValues(judicature?.["Geschaeftszahl"]),
    ecli: optionalString(judicature?.["EuropeanCaseLawIdentifier"]),
    documentUrl: optionalString(
      nestedRecord(headnote, "Data", "Metadaten", "Allgemein")?.["DokumentUrl"],
    ),
  };
};

type FetchHeadnoteListingOptions = {
  dependencies: AtRisDependencies;
  caseNumber: string;
  decisionDate: string;
  source: AtRisSourceDefinition;
  signal?: AbortSignal | undefined;
};

/**
 * Ask the publisher for the headnotes it indexes under this decision.
 *
 * A second population with its own document numbers, its own identifiers and
 * its own provisions, which the crawl's decision-text query never sees. The
 * answer is kept whole rather than the rows the crawl happened to read from
 * it, so a headnote field captured later is recoverable from the row.
 */
const fetchHeadnoteListing = async ({
  dependencies,
  caseNumber,
  decisionDate,
  source,
  signal,
}: FetchHeadnoteListingOptions): Promise<string | undefined> => {
  const response = await dependencies.request(
    headnoteListingQuery(source, caseNumber, decisionDate),
    { headers: { Accept: "application/json" }, redirect: "error" },
    {
      adapterKey: source.key,
      baseDelayMs: REQUEST_INTERVAL_MS,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.LIST,
    },
  );
  return response.ok ? await response.text() : undefined;
};

/** The headnotes a stored answer names for this decision, as the row keeps them. */
const headnotesOf = (
  source: AtRisSourceDefinition,
  headnoteListing: string | undefined,
  sourceDocumentId: string,
): readonly Record<string, unknown>[] => {
  if (headnoteListing === undefined) {
    return [];
  }
  const parsed = parseListingPage(
    Result.try({
      try: (): unknown => JSON.parse(headnoteListing),
      catch: () => undefined,
    }).unwrapOr(undefined),
  );
  if (parsed === undefined) {
    return [];
  }
  return parsed.items
    .filter((headnote) =>
      headnoteNamesDecision(source, headnote, sourceDocumentId),
    )
    .map(headnoteSummary);
};

/** Every payload fetched for one decision, under the name its role has. */
type RisStoredParts = {
  item: RisListingItem;
  documentXml?: string | undefined;
  headnoteListing?: string | undefined;
};

const storedRaw = ({
  item,
  documentXml,
  headnoteListing,
}: RisStoredParts): { sourceRaw: string; sourceRawContentType: string } => ({
  sourceRaw: encodeSourceRawEnvelope({
    [AT_RIS_PART.LISTING]: JSON.stringify(item),
    ...(documentXml === undefined
      ? {}
      : { [AT_RIS_PART.DOCUMENT_XML]: documentXml }),
    ...(headnoteListing === undefined
      ? {}
      : { [AT_RIS_PART.HEADNOTE_LISTING]: headnoteListing }),
  }),
  sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
});

const NO_SECTIONS: RisDocumentSections = {};

type BuildListingOnlyOptions = {
  identity: RisIdentity;
  item: RisListingItem;
  reason: string;
  source: AtRisSourceDefinition;
  rawDetail?: string | undefined;
};

const buildListingOnly = ({
  identity,
  item,
  reason,
  source,
  rawDetail,
}: BuildListingOnlyOptions): IngestionResult => {
  const { sourceDocumentId, sourceDocumentIdRepairAliases } = identity;
  const data = readDecisionMetadata(source, item);
  const caseNumber = data.caseNumber ?? `RIS ${sourceDocumentId}`;
  const court = data.court ?? `RIS ${source.application}`;
  const raw = storedRaw({ item, documentXml: rawDetail });
  return {
    sourceDocumentId,
    sourceDocumentIdRepairAliases,
    caseNumber,
    ...(data.caseNumber === undefined ? { caseNumberIsPlaceholder: true } : {}),
    isListingOnly: true,
    ecli: data.ecli,
    court,
    country: ADAPTER_MANIFESTS[source.key].country,
    language: LANGUAGE,
    decisionDate: data.decisionDate,
    decisionType: data.decisionType,
    sourceUrl: data.sourceUrl,
    documentUrl: listedDocumentUrl(
      source,
      item,
      sourceDocumentId,
      "Html",
      "html",
    ),
    // The listing states a text of its own for some applications, so a row
    // without its document is still not a row whose publisher wrote nothing.
    textFields: decisionTextFields(source, data, NO_SECTIONS),
    metadata: checkedDecisionMetadata({
      ...decisionMetadata(source, data, NO_SECTIONS),
      court,
      detailStatus: reason,
    }),
    rawHash: hashContent(raw.sourceRaw),
    documentAst: EMPTY_AST,
    parserVersion: PARSER_VERSIONS[source.key],
    ...raw,
  };
};

type BuildDecisionOptions = {
  cursor: string | null;
  dependencies: AtRisDependencies;
  item: RisListingItem;
  source: AtRisSourceDefinition;
  signal?: AbortSignal | undefined;
};

const buildDecision = async ({
  cursor,
  dependencies,
  item,
  source,
  signal,
}: BuildDecisionOptions): Promise<IngestionResult> => {
  const identity = identityOf(source, item);
  const { sourceDocumentId } = identity;
  if (identity.type === "quarantine") {
    return buildListingOnly({
      identity,
      item,
      reason: "publisher-id-unavailable",
      source,
    });
  }
  const data = readDecisionMetadata(source, item);
  if (data.caseNumber === undefined || data.court === undefined) {
    return buildListingOnly({
      identity,
      item,
      reason: "listing-metadata-incomplete",
      source,
    });
  }
  const xmlUrl = listedDocumentUrl(
    source,
    item,
    sourceDocumentId,
    "Xml",
    "xml",
  );
  if (xmlUrl === undefined) {
    return buildListingOnly({
      identity,
      item,
      reason: "xml-not-listed",
      source,
    });
  }

  const response = await dependencies.request(
    xmlUrl,
    { headers: { Accept: "application/xml" }, redirect: "error" },
    {
      adapterKey: source.key,
      baseDelayMs: REQUEST_INTERVAL_MS,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    },
  );
  if (response.status === 404 || response.status === 410) {
    return buildListingOnly({
      identity,
      item,
      reason: `detail-http-${response.status}`,
      source,
    });
  }
  if (!response.ok) {
    throw new AdapterFetchError({
      message: `RIS detail request failed: ${response.status}`,
      adapterKey: source.key,
      cursor,
      httpStatus: response.status,
    });
  }
  const xml = await response.text();
  if (xml.length < MIN_DOCUMENT_LENGTH) {
    return buildListingOnly({
      identity,
      item,
      reason: "detail-body-too-short",
      source,
      rawDetail: xml,
    });
  }

  const headnoteListing =
    data.decisionDate === undefined
      ? undefined
      : await fetchHeadnoteListing({
          caseNumber: data.caseNumber,
          decisionDate: data.decisionDate,
          dependencies,
          signal,
          source,
        });
  return assembleAtRisDecision(source, item, {
    documentXml: xml,
    headnoteListing,
  });
};

/** The payloads this publisher serves for one decision, beside its listing. */
export type AtRisDecisionPayloads = {
  readonly documentXml: string;
  /** The headnote answer, where the crawl received one. */
  readonly headnoteListing?: string | undefined;
};

/**
 * Build one decision from the payloads the publisher served for it.
 *
 * Split from the fetching above so the row a crawl writes and the row built
 * from stored payloads are the same row: everything derived — the headnotes
 * this decision's answer names, the sections, the text fields — is derived
 * here, from the parts the envelope keeps.
 */
export const assembleAtRisDecision = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
  { documentXml, headnoteListing }: AtRisDecisionPayloads,
): IngestionResult => {
  const identity = identityOf(source, item);
  const { sourceDocumentId, sourceDocumentIdRepairAliases } = identity;
  const data = readDecisionMetadata(source, item);
  if (
    identity.type === "quarantine" ||
    data.caseNumber === undefined ||
    data.court === undefined
  ) {
    return buildListingOnly({
      identity,
      item,
      reason:
        identity.type === "quarantine"
          ? "publisher-id-unavailable"
          : "listing-metadata-incomplete",
      source,
      rawDetail: documentXml,
    });
  }

  const parseResult = parseRisDecisionXml({
    sourceDocumentId,
    caseNumber: data.caseNumber,
    ecli: data.ecli,
    court: data.court,
    decisionDate: data.decisionDate,
    decisionType: data.decisionType,
    sourceUrl: data.sourceUrl,
    xml: documentXml,
  });
  if (Result.isError(parseResult)) {
    return buildListingOnly({
      identity,
      item,
      reason: "detail-xml-unparseable",
      source,
      rawDetail: documentXml,
    });
  }
  const parsed = parseResult.value;

  const raw = storedRaw({ item, documentXml, headnoteListing });
  return {
    sourceDocumentId,
    sourceDocumentIdRepairAliases,
    caseNumber: data.caseNumber,
    ecli: data.ecli,
    court: data.court,
    country: ADAPTER_MANIFESTS[source.key].country,
    language: LANGUAGE,
    decisionDate: data.decisionDate,
    decisionType: data.decisionType,
    fulltext: parsed.fulltext,
    sourceUrl: data.sourceUrl,
    documentUrl: listedDocumentUrl(
      source,
      item,
      sourceDocumentId,
      "Html",
      "html",
    ),
    textFields: decisionTextFields(source, data, parsed.sections),
    metadata: checkedDecisionMetadata({
      ...decisionMetadata(source, data, parsed.sections),
      headnotes: headnotesOf(source, headnoteListing, sourceDocumentId),
    }),
    rawHash: hashContent(raw.sourceRaw),
    documentAst: parsed.documentAst,
    sections: sectionsFromAst(parsed.documentAst.blocks),
    parserVersion: PARSER_VERSIONS[source.key],
    ...raw,
  };
};

type FetchListingOptions = {
  cursor: string | null;
  dependencies: AtRisDependencies;
  page: number;
  source: AtRisSourceDefinition;
  signal?: AbortSignal | undefined;
  slice?: string | undefined;
  courtFilter?: string | undefined;
};

/** A parsed listing beside the request that served it. */
type RisListingFetch = RisListingPage & { url: string };

const fetchListing = async ({
  cursor,
  dependencies,
  page,
  source,
  signal,
  slice,
  courtFilter,
}: FetchListingOptions): Promise<RisListingFetch> => {
  const url = listingQuery(source, slice, page, courtFilter);
  const response = await dependencies.request(
    url,
    { headers: { Accept: "application/json" }, redirect: "error" },
    {
      adapterKey: source.key,
      baseDelayMs: REQUEST_INTERVAL_MS,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.LIST,
    },
  );
  if (!response.ok) {
    throw new AdapterFetchError({
      message: `RIS listing request failed: ${response.status}`,
      adapterKey: source.key,
      cursor,
      httpStatus: response.status,
    });
  }
  const json: unknown = await response.json();
  const parsed = parseListingPage(json);
  if (
    parsed === undefined ||
    parsed.pageNumber !== page ||
    parsed.pageSize !== PAGE_SIZE
  ) {
    throw new AdapterFetchError({
      message: "RIS listing returned an invalid payload",
      adapterKey: source.key,
      cursor,
    });
  }
  return { ...parsed, url };
};

const nextSliceCursor = (
  source: AtRisSourceDefinition,
  slice: string,
  now: Date,
): CrawlCursor => {
  const current = tipSlice(source, now);
  const candidate = atRisNextMonth(slice);
  return {
    ...cursorForSlice(current),
    slice: candidate !== null && candidate <= current ? candidate : current,
  };
};

const restartSliceCursor = (slice: string): CrawlCursor => ({
  ...cursorForSlice(slice),
});

const listReconciliationSlicePage = async (
  source: AtRisSourceDefinition,
  dependencies: AtRisDependencies,
  { slice, page, signal }: ReconciliationSlicePageOptions,
): Promise<ReconciliationSlicePage> => {
  if (
    monthParts(slice) === undefined ||
    slice < source.firstSlice ||
    slice > tipSlice(source, dependencies.now()) ||
    !Number.isSafeInteger(page) ||
    page < 0
  ) {
    throw new AdapterFetchError({
      message: `Invalid RIS reconciliation page: ${slice}/${page}`,
      adapterKey: source.key,
      cursor: slice,
    });
  }
  await dependencies.sleep(REQUEST_INTERVAL_MS);
  const listing = await fetchListing({
    cursor: `reconciliation:${slice}:${page}`,
    dependencies,
    page: page + 1,
    source,
    signal,
    slice,
  });
  const totalPages =
    listing.total === 0 ? 0 : Math.ceil(listing.total / PAGE_SIZE);
  if (totalPages > MAX_SLICE_PAGES) {
    throw new AdapterFetchError({
      message: `RIS reconciliation slice exceeds ${MAX_SLICE_PAGES} pages`,
      adapterKey: source.key,
      cursor: slice,
    });
  }
  return {
    items: listing.items
      .filter((item) => !isExcludedItem(source, item))
      .map((item) => ({
        identity: {
          type: "document",
          sourceDocumentId: identityOf(source, item).sourceDocumentId,
        },
        payload: item,
      })),
    totalPages,
  };
};

const buildReconciliationDecision = async (
  source: AtRisSourceDefinition,
  dependencies: AtRisDependencies,
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (
    !isRecord(payload) ||
    nestedRecord(payload, "Data", "Metadaten") === undefined
  ) {
    return { type: "unkeyable" };
  }
  const identity = identityOf(source, payload);
  if (identity.type === "quarantine") {
    return { type: "detail-unavailable" };
  }
  const decision = await buildDecision({
    cursor: null,
    dependencies,
    item: payload,
    signal,
    source,
  });
  if (decision.isListingOnly !== true) {
    return { type: "built", decision };
  }
  const detailStatus = decision.metadata["detailStatus"];
  if (
    detailStatus === "xml-not-listed" ||
    detailStatus === "detail-http-404" ||
    detailStatus === "detail-http-410"
  ) {
    return { type: "detail-unavailable" };
  }
  throw new AdapterFetchError({
    message: `RIS reconciliation could not build detail: ${String(detailStatus)}`,
    adapterKey: source.key,
    cursor: null,
  });
};

type AtRisSourceAdapter<TKey extends AtRisAdapterKey> = SourceAdapter & {
  readonly key: TKey;
};

/**
 * No `result.judges`: none of the eleven applications states who sat. The
 * schema has no bench element, and the document prints the deciding body and
 * — for one application — an opening paragraph naming the panel in prose,
 * which is a passage to read rather than a roster the publisher stated.
 */
const createAdapter = <const TKey extends AtRisAdapterKey>(
  source: AtRisSourceDefinition & { readonly key: TKey },
  dependencies: AtRisDependencies,
): AtRisSourceAdapter<TKey> =>
  defineSourceAdapter({
    key: source.key,
    sourceSurfaces: atRisSourceSurfaces(source.key),
    sourceFields: atRisFieldInventory(profileOf(source)),
    language: LANGUAGE,
    minRequestIntervalMs: REQUEST_INTERVAL_MS,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    maxCycleMs: CYCLE_TIMEOUT_MS,
    maxSyncPages: 1,

    reconciliation: {
      firstSlice: source.firstSlice,
      sliceOf: (now) => tipSlice(source, now),
      nextSlice: (slice) => {
        const next = atRisNextMonth(slice);
        return next !== null && next <= tipSlice(source, dependencies.now())
          ? next
          : null;
      },
      previousSlice: (slice) => previousMonth(source.firstSlice, slice),
      // The engine's legacy field counts opaque slices; RIS slices are months.
      tipWindowDays: TIP_WINDOW_MONTHS,
      listSlicePage: async (options) =>
        await listReconciliationSlicePage(source, dependencies, options),
      buildDecision: async (payload, signal) =>
        await buildReconciliationDecision(
          source,
          dependencies,
          payload,
          signal,
        ),
    },

    async getTotalCount(signal) {
      try {
        const all = await fetchListing({
          cursor: null,
          dependencies,
          page: 1,
          signal,
          source,
        });
        if (!source.excludeForeignCourts) {
          return sourceTotalRead(all.total);
        }
        await dependencies.sleep(REQUEST_INTERVAL_MS);
        const excluded = await fetchListing({
          cursor: null,
          courtFilter: "AUSL",
          dependencies,
          page: 1,
          signal,
          source,
        });
        return excluded.total <= all.total
          ? sourceTotalRead(all.total - excluded.total)
          : sourceTotalProbeFailed(
              SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
            );
      } catch (error) {
        return { type: "probe-failed", errorTag: errorTag(error) };
      }
    },

    fetchPage: async (cursor, _config, signal) =>
      await Result.tryPromise({
        try: async () => {
          const state = decodeCursor(cursor, dependencies.now(), source);
          if (state === undefined) {
            throw new AdapterFetchError({
              message: `Invalid RIS cursor: ${cursor ?? "(none)"}`,
              adapterKey: source.key,
              cursor,
            });
          }
          const page = await fetchListing({
            cursor,
            dependencies,
            page: state.page,
            signal,
            slice: state.slice,
            source,
          });
          const expectedTotal = state.total ?? page.total;
          if (page.total !== expectedTotal) {
            return {
              decisions: [],
              nextCursor: encodeCursor(restartSliceCursor(state.slice)),
            };
          }
          if (page.total === 0) {
            const next = nextSliceCursor(
              source,
              state.slice,
              dependencies.now(),
            );
            return {
              decisions: [],
              nextCursor: encodeCursor(next),
            };
          }

          const totalPages = Math.ceil(page.total / PAGE_SIZE);
          if (totalPages > MAX_SLICE_PAGES) {
            throw new AdapterFetchError({
              message: `RIS crawl slice exceeds ${MAX_SLICE_PAGES} pages`,
              adapterKey: source.key,
              cursor,
            });
          }
          if (state.page > totalPages) {
            throw new AdapterFetchError({
              message: "RIS cursor points past the publisher's last page",
              adapterKey: source.key,
              cursor,
            });
          }
          const digest = itemDigest(source, state.digest, page.items);
          const foreignOnPage = page.items.filter((item) =>
            isExcludedItem(source, item),
          ).length;
          const foreign = state.foreign + foreignOnPage;

          if (state.phase === CURSOR_PHASE.VERIFY) {
            if (state.page < totalPages) {
              return {
                decisions: [],
                nextCursor: encodeCursor({
                  ...state,
                  page: state.page + 1,
                  digest,
                  foreign,
                  total: expectedTotal,
                }),
              };
            }
            if (
              digest !== state.expectedDigest ||
              foreign !== state.expectedForeign
            ) {
              return {
                decisions: [],
                nextCursor: encodeCursor(restartSliceCursor(state.slice)),
              };
            }
            const next = nextSliceCursor(
              source,
              state.slice,
              dependencies.now(),
            );
            return {
              decisions: [],
              nextCursor: encodeCursor(next),
            };
          }

          const decisions = await Array.fromAsync(
            page.items.filter((item) => !isExcludedItem(source, item)),
            async (item) =>
              await buildDecision({
                cursor,
                dependencies,
                item,
                signal,
                source,
              }),
          );
          const collected = state.collected + decisions.length;
          if (state.page < totalPages) {
            return {
              decisions,
              nextCursor: encodeCursor({
                ...state,
                page: state.page + 1,
                digest,
                foreign,
                collected,
                total: expectedTotal,
              }),
              sourceUrl: page.url,
            };
          }
          if (collected !== expectedTotal - foreign) {
            return {
              decisions: [],
              nextCursor: encodeCursor(restartSliceCursor(state.slice)),
            };
          }
          return {
            decisions,
            nextCursor: encodeCursor({
              slice: state.slice,
              phase: CURSOR_PHASE.VERIFY,
              page: 1,
              digest: START_DIGEST,
              foreign: 0,
              collected,
              total: expectedTotal,
              expectedDigest: digest,
              expectedForeign: foreign,
            }),
            sourceUrl: page.url,
          };
        },
        catch: adapterCatch(source.key, cursor),
      }),
  });

export const createAtCourtsAdapter = (
  dependencies: Partial<AtRisDependencies> = {},
): AtRisSourceAdapter<typeof ADAPTER_KEYS.AT_COURTS> =>
  createAdapter(AT_COURTS_SOURCE, { ...DEFAULT_DEPENDENCIES, ...dependencies });

export const createAtRisSourceAdapter = <const TKey extends AtRisAdapterKey>(
  source: AtRisSourceDefinition & { readonly key: TKey },
  dependencies: Partial<AtRisDependencies> = {},
): AtRisSourceAdapter<TKey> =>
  createAdapter(source, { ...DEFAULT_DEPENDENCIES, ...dependencies });

export const atCourtsAdapter = createAtCourtsAdapter();
