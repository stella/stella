import { panic, Result } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
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
  IngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { fetchAtRisWithRetry } from "@/api/handlers/case-law/ingestion/adapters/at-ris-throttle";
import type { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";

const API_URL = "https://data.bka.gv.at/ris/api/v2.6/Judikatur";
const DOCUMENT_ORIGIN = "https://www.ris.bka.gv.at";
const COUNTRY = "AUT";
const LANGUAGE = "de";
const PAGE_SIZE = 100;
const REQUEST_INTERVAL_MS = 5000;
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

export type AtRisSourceDefinition = {
  application: string;
  excludeForeignCourts: boolean;
  firstSlice: string;
  key: AdapterKey;
  lastSlice?: string | undefined;
  name: string;
};

export type AtRisDependencies = {
  now: () => Date;
  request: typeof fetchWithRetry;
  sleep: (ms: number) => Promise<void>;
};

const JUSTIZ_SOURCE = {
  application: "Justiz",
  excludeForeignCourts: true,
  firstSlice: "1925-04",
  key: ADAPTER_KEYS.AT_COURTS,
  name: "Austrian Courts (RIS Justiz)",
} as const satisfies AtRisSourceDefinition;

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
  previousMonth(JUSTIZ_SOURCE.firstSlice, slice);

export const atRisMonthOf = (date: Date): string =>
  formatMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);

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
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0))
    .getUTCDate()
    .toString()
    .padStart(2, "0");
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
  court?: string,
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
  if (court !== undefined) {
    params.set("Gericht", court);
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

const contentUrls = (item: RisListingItem): Record<string, string> => {
  const raw = nestedRecord(
    item,
    "Data",
    "Dokumentliste",
    "ContentReference",
    "Urls",
  )?.["ContentUrl"];
  let entries: unknown[] = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw !== undefined) {
    entries = [raw];
  }
  const urls: Record<string, string> = {};
  for (const entry of entries) {
    const record = asRecord(entry);
    const dataType = optionalString(record?.["DataType"]);
    const url = optionalString(record?.["Url"]);
    if (dataType !== undefined && url !== undefined) {
      urls[dataType] = url;
    }
  }
  return urls;
};

const constructedDocumentUrl = (
  source: AtRisSourceDefinition,
  sourceDocumentId: string,
  extension: "html" | "xml",
): string => {
  const id = encodeURIComponent(sourceDocumentId);
  return `${DOCUMENT_ORIGIN}/Dokumente/${source.application}/${id}/${id}.${extension}`;
};

const listedFormatMatches = (
  source: AtRisSourceDefinition,
  item: RisListingItem,
  sourceDocumentId: string,
  dataType: "Html" | "Xml",
  extension: "html" | "xml",
): boolean =>
  contentUrls(item)[dataType] ===
  constructedDocumentUrl(source, sourceDocumentId, extension);

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
  const sourceRaw = JSON.stringify({
    listing: item,
    ...(rawDetail === undefined ? {} : { documentXml: rawDetail }),
  });
  return {
    sourceDocumentId,
    sourceDocumentIdRepairAliases,
    caseNumber,
    ...(data.caseNumber === undefined ? { caseNumberIsPlaceholder: true } : {}),
    isListingOnly: true,
    ecli: data.ecli,
    court,
    country: COUNTRY,
    language: LANGUAGE,
    decisionDate: data.decisionDate,
    decisionType: data.decisionType,
    sourceUrl: data.sourceUrl,
    documentUrl: listedFormatMatches(
      source,
      item,
      sourceDocumentId,
      "Html",
      "html",
    )
      ? constructedDocumentUrl(source, sourceDocumentId, "html")
      : undefined,
    metadata: {
      ecli: data.ecli,
      court,
      decisionDate: data.decisionDate,
      decisionType: data.decisionType,
      ris: data.metadata,
      statutes: data.statutes,
      legalAreas: data.legalAreas,
      headnoteNumbers: data.headnoteNumbers,
      additionalCaseNumbers: data.caseNumbers.slice(1),
      published: data.published,
      modified: data.modified,
      contentFormats: Object.keys(contentUrls(item)),
      detailStatus: reason,
      sourceAttribution: "RIS, Austrian Federal Chancellery, CC BY 4.0",
    },
    rawHash: hashContent(sourceRaw),
    documentAst: EMPTY_AST,
    parserVersion: PARSER_VERSIONS[source.key],
    sourceRaw,
    sourceRawContentType: "application/json",
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
  const { sourceDocumentId, sourceDocumentIdRepairAliases } = identity;
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
  if (!listedFormatMatches(source, item, sourceDocumentId, "Xml", "xml")) {
    return buildListingOnly({
      identity,
      item,
      reason: "xml-not-listed",
      source,
    });
  }

  const xmlUrl = constructedDocumentUrl(source, sourceDocumentId, "xml");
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

  let parsed: ReturnType<typeof parseRisDecisionXml>;
  try {
    parsed = parseRisDecisionXml({
      sourceDocumentId,
      caseNumber: data.caseNumber,
      ecli: data.ecli,
      court: data.court,
      decisionDate: data.decisionDate,
      decisionType: data.decisionType,
      sourceUrl: data.sourceUrl,
      xml,
    });
  } catch {
    return buildListingOnly({
      identity,
      item,
      reason: "detail-xml-unparseable",
      source,
      rawDetail: xml,
    });
  }

  const sourceRaw = JSON.stringify({ listing: item, documentXml: xml });
  const documentUrl = listedFormatMatches(
    source,
    item,
    sourceDocumentId,
    "Html",
    "html",
  )
    ? constructedDocumentUrl(source, sourceDocumentId, "html")
    : undefined;
  return {
    sourceDocumentId,
    sourceDocumentIdRepairAliases,
    caseNumber: data.caseNumber,
    ecli: data.ecli,
    court: data.court,
    country: COUNTRY,
    language: LANGUAGE,
    decisionDate: data.decisionDate,
    decisionType: data.decisionType,
    fulltext: parsed.fulltext,
    sourceUrl: data.sourceUrl,
    documentUrl,
    metadata: {
      ecli: data.ecli,
      court: data.court,
      decisionDate: data.decisionDate,
      decisionType: data.decisionType,
      ris: data.metadata,
      statutes: data.statutes,
      legalAreas: data.legalAreas,
      headnoteNumbers: data.headnoteNumbers,
      additionalCaseNumbers: data.caseNumbers.slice(1),
      published: data.published,
      modified: data.modified,
      contentFormats: Object.keys(contentUrls(item)),
      sourceAttribution: "RIS, Austrian Federal Chancellery, CC BY 4.0",
    },
    rawHash: hashContent(sourceRaw),
    documentAst: parsed.documentAst,
    sections: sectionsFromAst(parsed.documentAst.blocks),
    parserVersion: PARSER_VERSIONS[source.key],
    sourceRaw,
    sourceRawContentType: "application/json",
  };
};

type FetchListingOptions = {
  cursor: string | null;
  dependencies: AtRisDependencies;
  page: number;
  source: AtRisSourceDefinition;
  signal?: AbortSignal | undefined;
  slice?: string | undefined;
  court?: string | undefined;
};

const fetchListing = async ({
  cursor,
  dependencies,
  page,
  source,
  signal,
  slice,
  court,
}: FetchListingOptions): Promise<RisListingPage> => {
  const response = await dependencies.request(
    listingQuery(source, slice, page, court),
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
  return parsed;
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

type AtRisSourceAdapter<TKey extends AdapterKey> = SourceAdapter & {
  readonly key: TKey;
};

const createAdapter = <const TKey extends AdapterKey>(
  source: AtRisSourceDefinition & { readonly key: TKey },
  dependencies: AtRisDependencies,
): AtRisSourceAdapter<TKey> =>
  defineSourceAdapter({
    key: source.key,
    name: source.name,
    country: COUNTRY,
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
          court: "AUSL",
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
              message: `Invalid RIS cursor: ${cursor}`,
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
          };
        },
        catch: adapterCatch(source.key, cursor),
      }),
  });

export const createAtCourtsAdapter = (
  dependencies: Partial<AtRisDependencies> = {},
): AtRisSourceAdapter<typeof ADAPTER_KEYS.AT_COURTS> =>
  createAdapter(JUSTIZ_SOURCE, { ...DEFAULT_DEPENDENCIES, ...dependencies });

export const createAtRisSourceAdapter = <const TKey extends AdapterKey>(
  source: AtRisSourceDefinition & { readonly key: TKey },
  dependencies: Partial<AtRisDependencies> = {},
): AtRisSourceAdapter<TKey> =>
  createAdapter(source, { ...DEFAULT_DEPENDENCIES, ...dependencies });

export const atCourtsAdapter = createAtCourtsAdapter();
