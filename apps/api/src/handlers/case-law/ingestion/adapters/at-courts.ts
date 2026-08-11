import { panic, Result } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
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
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { isRecord } from "@/api/lib/type-guards";

const API_URL = "https://data.bka.gv.at/ris/api/v2.6/Judikatur";
const DOCUMENT_ORIGIN = "https://www.ris.bka.gv.at";
const APPLICATION = "Justiz";
const COUNTRY = "AUT";
const LANGUAGE = "de";
const FIRST_SLICE = "1925-04";
const PAGE_SIZE = 100;
const REQUEST_INTERVAL_MS = 5000;
const MIN_DOCUMENT_LENGTH = 100;
const START_DIGEST = "start";
const FOREIGN_ORGAN_PREFIX = "AUSL";

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

type RisDependencies = {
  now: () => Date;
  request: typeof fetchWithRetry;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_DEPENDENCIES: RisDependencies = {
  now: () => new Date(),
  request: fetchWithRetry,
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

export const atRisPreviousMonth = (slice: string): string | null => {
  const parts = monthParts(slice);
  if (parts === undefined || slice <= FIRST_SLICE) {
    return null;
  }
  const previous =
    parts.month === 1
      ? formatMonth(parts.year - 1, 12)
      : formatMonth(parts.year, parts.month - 1);
  return previous < FIRST_SLICE ? null : previous;
};

export const atRisMonthOf = (date: Date): string =>
  formatMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);

export const atRisLastCompleteMonth = (date: Date): string =>
  atRisPreviousMonth(atRisMonthOf(date)) ?? FIRST_SLICE;

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
): CrawlCursor | undefined => {
  const lastCompleteMonth = atRisLastCompleteMonth(now);
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
    slice < FIRST_SLICE ||
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
  slice: string | undefined,
  page: number,
  court?: string,
): string => {
  const params = new URLSearchParams({
    Applikation: APPLICATION,
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
    items === undefined
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
  sourceDocumentId: string,
  extension: "html" | "xml",
): string => {
  const id = encodeURIComponent(sourceDocumentId);
  return `${DOCUMENT_ORIGIN}/Dokumente/${APPLICATION}/${id}/${id}.${extension}`;
};

const listedFormatMatches = (
  item: RisListingItem,
  sourceDocumentId: string,
  dataType: "Html" | "Xml",
  extension: "html" | "xml",
): boolean =>
  contentUrls(item)[dataType] ===
  constructedDocumentUrl(sourceDocumentId, extension);

const readDecisionMetadata = (item: RisListingItem) => {
  const metadata = nestedRecord(item, "Data", "Metadaten");
  const technical = asRecord(metadata?.["Technisch"]);
  const general = asRecord(metadata?.["Allgemein"]);
  const judicature = asRecord(metadata?.["Judikatur"]);
  const justice = asRecord(judicature?.["Justiz"]);
  const caseNumbers = itemValues(judicature?.["Geschaeftszahl"]);
  const decisionTexts = asRecord(justice?.["Entscheidungstexte"])?.["item"];
  const firstDecisionText = asRecord(
    Array.isArray(decisionTexts) ? decisionTexts.at(0) : decisionTexts,
  );
  const decisionType = optionalString(firstDecisionText?.["Entscheidungsart"]);
  return {
    metadata,
    general,
    judicature,
    justice,
    caseNumbers,
    decisionType: decisionType?.toLocaleLowerCase("de-AT"),
    caseNumber: caseNumbers.at(0),
    court:
      optionalString(justice?.["Gericht"]) ??
      optionalString(technical?.["Organ"]),
    decisionDate: optionalString(judicature?.["Entscheidungsdatum"]),
    ecli: optionalString(judicature?.["EuropeanCaseLawIdentifier"]),
    sourceUrl: optionalString(general?.["DokumentUrl"]),
    published: optionalString(general?.["Veroeffentlicht"]),
    modified: optionalString(general?.["Geaendert"]),
    statutes: itemValues(judicature?.["Normen"]),
    legalAreas: itemValues(justice?.["Rechtsgebiete"]),
    headnoteNumbers: itemValues(justice?.["Rechtssatznummern"]),
  };
};

const quarantineSourceDocumentIds = (item: RisListingItem): string[] => {
  const data = readDecisionMetadata(item);
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

const identityOf = (item: RisListingItem): RisIdentity => {
  const quarantineIds = quarantineSourceDocumentIds(item);
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
  previous: string,
  items: readonly RisListingItem[],
): string =>
  hashContent(
    [previous, ...items.map((item) => identityOf(item).sourceDocumentId)].join(
      "\n",
    ),
  );

type BuildListingOnlyOptions = {
  identity: RisIdentity;
  item: RisListingItem;
  reason: string;
  rawDetail?: string | undefined;
};

const buildListingOnly = ({
  identity,
  item,
  reason,
  rawDetail,
}: BuildListingOnlyOptions): IngestionResult => {
  const { sourceDocumentId, sourceDocumentIdRepairAliases } = identity;
  const data = readDecisionMetadata(item);
  const caseNumber = data.caseNumber ?? `RIS ${sourceDocumentId}`;
  const court = data.court ?? "RIS Justiz";
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
    documentUrl: listedFormatMatches(item, sourceDocumentId, "Html", "html")
      ? constructedDocumentUrl(sourceDocumentId, "html")
      : undefined,
    metadata: {
      ecli: data.ecli,
      court,
      decisionDate: data.decisionDate,
      decisionType: data.decisionType,
      ris: data.metadata,
      detailStatus: reason,
      sourceAttribution: "RIS, Austrian Federal Chancellery, CC BY 4.0",
    },
    rawHash: hashContent(sourceRaw),
    documentAst: EMPTY_AST,
    parserVersion: PARSER_VERSION,
    sourceRaw,
    sourceRawContentType: "application/json",
  };
};

type BuildDecisionOptions = {
  cursor: string | null;
  dependencies: RisDependencies;
  item: RisListingItem;
  signal?: AbortSignal | undefined;
};

const buildDecision = async ({
  cursor,
  dependencies,
  item,
  signal,
}: BuildDecisionOptions): Promise<IngestionResult> => {
  const identity = identityOf(item);
  const { sourceDocumentId, sourceDocumentIdRepairAliases } = identity;
  if (identity.type === "quarantine") {
    return buildListingOnly({
      identity,
      item,
      reason: "publisher-id-unavailable",
    });
  }
  const data = readDecisionMetadata(item);
  if (data.caseNumber === undefined || data.court === undefined) {
    return buildListingOnly({
      identity,
      item,
      reason: "listing-metadata-incomplete",
    });
  }
  if (!listedFormatMatches(item, sourceDocumentId, "Xml", "xml")) {
    return buildListingOnly({
      identity,
      item,
      reason: "xml-not-listed",
    });
  }

  await dependencies.sleep(REQUEST_INTERVAL_MS);
  const xmlUrl = constructedDocumentUrl(sourceDocumentId, "xml");
  const response = await dependencies.request(
    xmlUrl,
    { headers: { Accept: "application/xml" }, redirect: "error" },
    {
      adapterKey: ADAPTER_KEYS.AT_COURTS,
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
    });
  }
  if (!response.ok) {
    throw new AdapterFetchError({
      message: `RIS detail request failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.AT_COURTS,
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
      rawDetail: xml,
    });
  }

  const sourceRaw = JSON.stringify({ listing: item, documentXml: xml });
  const documentUrl = listedFormatMatches(
    item,
    sourceDocumentId,
    "Html",
    "html",
  )
    ? constructedDocumentUrl(sourceDocumentId, "html")
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
    parserVersion: PARSER_VERSION,
    sourceRaw,
    sourceRawContentType: "application/json",
  };
};

type FetchListingOptions = {
  cursor: string | null;
  dependencies: RisDependencies;
  page: number;
  signal?: AbortSignal | undefined;
  slice?: string | undefined;
  court?: string | undefined;
};

const fetchListing = async ({
  cursor,
  dependencies,
  page,
  signal,
  slice,
  court,
}: FetchListingOptions): Promise<RisListingPage> => {
  const response = await dependencies.request(
    listingQuery(slice, page, court),
    { headers: { Accept: "application/json" }, redirect: "error" },
    {
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      baseDelayMs: REQUEST_INTERVAL_MS,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.LIST,
    },
  );
  if (!response.ok) {
    throw new AdapterFetchError({
      message: `RIS listing request failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.AT_COURTS,
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
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      cursor,
    });
  }
  return parsed;
};

const nextSliceCursor = (slice: string, now: Date): CrawlCursor => {
  const current = atRisLastCompleteMonth(now);
  const candidate = atRisNextMonth(slice);
  return {
    ...cursorForSlice(current),
    slice: candidate !== null && candidate <= current ? candidate : current,
  };
};

const restartSliceCursor = (slice: string): CrawlCursor => ({
  ...cursorForSlice(slice),
});

const createAdapter = (dependencies: RisDependencies): SourceAdapter =>
  defineSourceAdapter({
    key: ADAPTER_KEYS.AT_COURTS,
    name: "Austrian Courts (RIS Justiz)",
    country: COUNTRY,
    language: LANGUAGE,
    minRequestIntervalMs: REQUEST_INTERVAL_MS,
    pageTimeoutMs: 15 * 60_000,
    maxCycleMs: 20 * 60_000,
    maxSyncPages: 1,

    async getTotalCount(signal) {
      try {
        const all = await fetchListing({
          cursor: null,
          dependencies,
          page: 1,
          signal,
        });
        await dependencies.sleep(REQUEST_INTERVAL_MS);
        const foreign = await fetchListing({
          cursor: null,
          dependencies,
          page: 1,
          signal,
          court: "AUSL",
        });
        return foreign.total <= all.total ? all.total - foreign.total : null;
      } catch {
        return null;
      }
    },

    fetchPage: async (cursor, _config, signal) =>
      await Result.tryPromise({
        try: async () => {
          const state = decodeCursor(cursor, dependencies.now());
          if (state === undefined) {
            throw new AdapterFetchError({
              message: `Invalid RIS cursor: ${cursor}`,
              adapterKey: ADAPTER_KEYS.AT_COURTS,
              cursor,
            });
          }
          const page = await fetchListing({
            cursor,
            dependencies,
            page: state.page,
            signal,
            slice: state.slice,
          });
          const expectedTotal = state.total ?? page.total;
          if (page.total !== expectedTotal) {
            return {
              decisions: [],
              nextCursor: encodeCursor(restartSliceCursor(state.slice)),
            };
          }
          if (page.total === 0) {
            const next = nextSliceCursor(state.slice, dependencies.now());
            return {
              decisions: [],
              nextCursor: encodeCursor(next),
              coverage: { slice: state.slice, reported: 0, collected: 0 },
            };
          }

          const totalPages = Math.ceil(page.total / PAGE_SIZE);
          if (state.page > totalPages) {
            throw new AdapterFetchError({
              message: "RIS cursor points past the publisher's last page",
              adapterKey: ADAPTER_KEYS.AT_COURTS,
              cursor,
            });
          }
          const digest = itemDigest(state.digest, page.items);
          const foreignOnPage = page.items.filter(isForeignItem).length;
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
            const next = nextSliceCursor(state.slice, dependencies.now());
            return {
              decisions: [],
              nextCursor: encodeCursor(next),
              coverage: {
                slice: state.slice,
                reported: expectedTotal - foreign,
                collected: state.collected,
              },
            };
          }

          const decisions: IngestionResult[] = [];
          for (const item of page.items) {
            if (isForeignItem(item)) {
              continue;
            }
            decisions.push(
              // eslint-disable-next-line no-await-in-loop -- RIS requires a five-second gap between document requests
              await buildDecision({
                cursor,
                dependencies,
                item,
                signal,
              }),
            );
          }
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
        catch: adapterCatch(ADAPTER_KEYS.AT_COURTS, cursor),
      }),
  });

export const createAtCourtsAdapter = (
  dependencies: Partial<RisDependencies> = {},
): SourceAdapter => createAdapter({ ...DEFAULT_DEPENDENCIES, ...dependencies });

export const atCourtsAdapter = createAtCourtsAdapter();
