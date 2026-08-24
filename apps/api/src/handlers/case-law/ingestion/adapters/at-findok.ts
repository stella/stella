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
  fetchAtFindokWithRetry,
  FINDOK_REQUEST_INTERVAL_MS,
} from "@/api/handlers/case-law/ingestion/adapters/at-findok-throttle";
import type { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseFindokDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-findok";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import { isUuid } from "@/api/lib/custom-schema";
import { loadDocxArchive } from "@/api/lib/docx-archive";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { isRecord } from "@/api/lib/type-guards";

const FINDOK_ORIGIN = "https://findok.bmf.gv.at";
const IWG_ROOT = `${FINDOK_ORIGIN}/findok/iwg`;
const COUNTRY = "AUT";
const LANGUAGE = "de";
const CRAWL_PAGE_SIZE = 10;
const RECONCILIATION_PAGE_SIZE = 100;
const MANIFEST_CACHE_MS = 15 * 60_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 12 * 1024 * 1024;
const START_DIGEST = "start";
const QUARANTINE_ID_PREFIX = "findok-quarantine:";

const COLLECTIONS = {
  bfg: {
    authority: "BFG",
    firstYear: 2014,
    manifestUrl: `${IWG_ROOT}/bestandsliste-bfg.gz`,
  },
  ufs: {
    authority: "UFS",
    firstYear: 2003,
    lastYear: 2013,
    manifestUrl: `${IWG_ROOT}/bestandsliste-ufs.gz`,
  },
} as const;

type FindokCollection = keyof typeof COLLECTIONS;

type FindokManifestItem = {
  appdat: string;
  behoerde: string;
  dokumentId: string;
  dokumenttyp: string;
  gueltig: boolean;
  gz: string;
  inFindokSeitDate: string | undefined;
  pathPdf: string;
  pathZip: string;
  raw: Record<string, unknown>;
  sourceDocumentIdRepairAliases: readonly string[] | undefined;
  stammNr: number;
  titel: string | undefined;
};

type FindokManifest = {
  collection: FindokCollection;
  generatedAt: string;
  items: FindokManifestItem[];
  snapshotId: string;
};

type FindokListingPayload = {
  collection: FindokCollection;
  item: FindokManifestItem;
};

const CURSOR_PHASE = {
  COLLECT: "collect",
  VERIFY: "verify",
} as const;

type CrawlCursorBase = {
  collected: number;
  digest: string;
  page: number;
  slice: string;
  snapshotId: string | null;
  total: number | null;
};

type CrawlCursor =
  | (CrawlCursorBase & {
      expectedDigest: null;
      phase: typeof CURSOR_PHASE.COLLECT;
    })
  | (CrawlCursorBase & {
      expectedDigest: string;
      phase: typeof CURSOR_PHASE.VERIFY;
    });

export type AtFindokDependencies = {
  now: () => Date;
  request: typeof fetchWithRetry;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_DEPENDENCIES: AtFindokDependencies = {
  now: () => new Date(),
  request: fetchAtFindokWithRetry,
  sleep: Bun.sleep,
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const parseDate = (value: string): string | undefined => {
  const match = /^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})$/u.exec(value);
  const year = Number(match?.groups?.["year"]);
  const month = Number(match?.groups?.["month"]);
  const day = Number(match?.groups?.["day"]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : undefined;
};

const manifestItem = (value: unknown): FindokManifestItem | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const stammNr = value["stammNr"];
  const gueltig = value["gueltig"];
  const item = {
    stammNr,
    pathZip: optionalString(value["pathZip"]),
    pathPdf: optionalString(value["pathPdf"]),
    dokumenttyp: optionalString(value["dokumenttyp"]),
    behoerde: optionalString(value["behoerde"]),
    appdat: optionalString(value["appdat"]),
    gz: optionalString(value["gz"]),
    titel: optionalString(value["titel"]),
    inFindokSeitDate: optionalString(value["inFindokSeitDate"]),
    gueltig,
    dokumentId: optionalString(value["dokumentId"]),
  };
  if (
    typeof stammNr !== "number" ||
    !Number.isSafeInteger(stammNr) ||
    stammNr < 1 ||
    typeof gueltig !== "boolean" ||
    item.pathZip === undefined ||
    item.pathPdf === undefined ||
    item.dokumenttyp === undefined ||
    item.behoerde === undefined ||
    item.appdat === undefined ||
    parseDate(item.appdat) === undefined ||
    item.gz === undefined
  ) {
    return undefined;
  }
  const stem = String(stammNr);
  const zipPattern = new RegExp(`^\\d{1,3}/${stem}/${stem}\\.zip$`, "u");
  const pdfPattern = new RegExp(`^\\d{1,3}/${stem}/${stem}\\.1\\.pdf$`, "u");
  if (!zipPattern.test(item.pathZip) || !pdfPattern.test(item.pathPdf)) {
    return undefined;
  }
  const quarantineId = `${QUARANTINE_ID_PREFIX}${hashContent(
    JSON.stringify({
      appdat: item.appdat,
      behoerde: item.behoerde,
      dokumenttyp: item.dokumenttyp,
      gz: item.gz,
      pathPdf: item.pathPdf,
      pathZip: item.pathZip,
      stammNr,
    }),
  )}`;
  const publisherId =
    item.dokumentId !== undefined &&
    !item.dokumentId.startsWith(QUARANTINE_ID_PREFIX) &&
    isUuid(item.dokumentId) &&
    isPersistableSourceDocumentId(item.dokumentId)
      ? item.dokumentId
      : undefined;
  return {
    appdat: item.appdat,
    behoerde: item.behoerde,
    dokumentId: publisherId ?? quarantineId,
    dokumenttyp: item.dokumenttyp,
    gueltig,
    gz: item.gz,
    inFindokSeitDate: item.inFindokSeitDate,
    pathPdf: item.pathPdf,
    pathZip: item.pathZip,
    raw: value,
    sourceDocumentIdRepairAliases:
      publisherId === undefined ? undefined : [quarantineId],
    stammNr,
    titel: item.titel,
  };
};

const readStreamBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new TypeError(`Findok response exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const decompressGzipIfNeeded = async (
  bytes: Uint8Array,
): Promise<Uint8Array> => {
  if (bytes.at(0) !== 0x1f || bytes.at(1) !== 0x8b) {
    return bytes;
  }
  return await readStreamBounded(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    MAX_MANIFEST_BYTES,
  );
};

export const parseFindokManifest = (
  collection: FindokCollection,
  text: string,
): FindokManifest => {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value["data"])) {
    throw new TypeError("Findok manifest has an invalid envelope");
  }
  const generatedAt = optionalString(value["generierungsdatum"]);
  if (generatedAt === undefined) {
    throw new TypeError("Findok manifest has no generation timestamp");
  }
  const items: FindokManifestItem[] = [];
  const identities = new Set<string>();
  for (const [index, raw] of value["data"].entries()) {
    // Rows the publisher explicitly marks invalid are outside its active
    // inventory, even when their optional document fields are incomplete.
    if (isRecord(raw) && raw["gueltig"] === false) {
      continue;
    }
    const item = manifestItem(raw);
    if (item === undefined) {
      throw new TypeError(
        `Findok manifest contains an invalid item at ${index}`,
      );
    }
    if (identities.has(item.dokumentId)) {
      throw new TypeError("Findok manifest contains a duplicate document ID");
    }
    identities.add(item.dokumentId);
    if (item.gueltig) {
      items.push(item);
    }
  }
  items.sort((left, right) => {
    if (left.dokumentId === right.dokumentId) {
      return 0;
    }
    return left.dokumentId < right.dokumentId ? -1 : 1;
  });
  return {
    collection,
    generatedAt,
    items,
    snapshotId: hashContent(text),
  };
};

type ManifestLoader = (
  collection: FindokCollection,
  signal?: AbortSignal,
) => Promise<FindokManifest>;

const createManifestLoader = (
  dependencies: AtFindokDependencies,
): ManifestLoader => {
  const cache = new Map<
    FindokCollection,
    { checkedAt: number; manifest: FindokManifest }
  >();
  return async (collection, signal) => {
    const cached = cache.get(collection);
    if (
      cached !== undefined &&
      dependencies.now().getTime() - cached.checkedAt < MANIFEST_CACHE_MS
    ) {
      return cached.manifest;
    }
    const response = await dependencies.request(
      COLLECTIONS[collection].manifestUrl,
      {
        headers: { Accept: "application/gzip, application/json" },
        redirect: "error",
      },
      {
        adapterKey: ADAPTER_KEYS.AT_FINDOK,
        baseDelayMs: FINDOK_REQUEST_INTERVAL_MS,
        signal,
        timeoutMs: ADAPTER_TIMEOUT.LIST,
      },
    );
    if (!response.ok || response.body === null) {
      throw new AdapterFetchError({
        message: `Findok manifest request failed: ${response.status}`,
        adapterKey: ADAPTER_KEYS.AT_FINDOK,
        cursor: null,
        httpStatus: response.status,
      });
    }
    const responseBytes = await readStreamBounded(
      response.body,
      MAX_MANIFEST_BYTES,
    );
    const bytes = await decompressGzipIfNeeded(responseBytes);
    const manifest = parseFindokManifest(
      collection,
      new TextDecoder().decode(bytes),
    );
    cache.set(collection, {
      checkedAt: dependencies.now().getTime(),
      manifest,
    });
    return manifest;
  };
};

const sliceParts = (
  slice: string,
): { collection: FindokCollection; year: number } | undefined => {
  const match = /^(?<year>\d{4})-(?<collection>bfg|ufs)$/u.exec(slice);
  const year = Number(match?.groups?.["year"]);
  const collection = match?.groups?.["collection"];
  if (
    !Number.isInteger(year) ||
    (collection !== "bfg" && collection !== "ufs")
  ) {
    return undefined;
  }
  const definition = COLLECTIONS[collection];
  if (
    year < definition.firstYear ||
    ("lastYear" in definition && year > definition.lastYear)
  ) {
    return undefined;
  }
  return { collection, year };
};

const tipSlice = (now: Date): string => `${now.getUTCFullYear()}-bfg`;

export const atFindokNextSlice = (
  slice: string,
  now = new Date(),
): string | null => {
  const parts = sliceParts(slice);
  if (parts === undefined) {
    return null;
  }
  if (parts.collection === "ufs") {
    return parts.year === COLLECTIONS.ufs.lastYear
      ? `${COLLECTIONS.bfg.firstYear}-bfg`
      : `${parts.year + 1}-ufs`;
  }
  const next = `${parts.year + 1}-bfg`;
  return next <= tipSlice(now) ? next : null;
};

export const atFindokPreviousSlice = (slice: string): string | null => {
  const parts = sliceParts(slice);
  if (parts === undefined) {
    return null;
  }
  if (parts.collection === "bfg") {
    return parts.year === COLLECTIONS.bfg.firstYear
      ? `${COLLECTIONS.ufs.lastYear}-ufs`
      : `${parts.year - 1}-bfg`;
  }
  return parts.year === COLLECTIONS.ufs.firstYear
    ? null
    : `${parts.year - 1}-ufs`;
};

const itemsForSlice = (
  manifest: FindokManifest,
  year: number,
): FindokManifestItem[] =>
  manifest.items.filter((item) =>
    parseDate(item.appdat)?.startsWith(`${year}-`),
  );

const cursorForSlice = (slice: string): CrawlCursor => ({
  collected: 0,
  digest: START_DIGEST,
  expectedDigest: null,
  page: 0,
  phase: CURSOR_PHASE.COLLECT,
  slice,
  snapshotId: null,
  total: null,
});

const encodeCursor = (cursor: CrawlCursor): string => JSON.stringify(cursor);

const decodeCursor = (
  value: string | null,
  now: Date,
): CrawlCursor | undefined => {
  if (value === null) {
    return cursorForSlice(tipSlice(now));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const slice = optionalString(parsed["slice"]);
  const phase = parsed["phase"];
  const page = parsed["page"];
  const digest = optionalString(parsed["digest"]);
  const collected = parsed["collected"];
  const total = parsed["total"];
  const snapshotId = parsed["snapshotId"];
  const expectedDigest = parsed["expectedDigest"];
  if (
    slice === undefined ||
    sliceParts(slice) === undefined ||
    slice > tipSlice(now) ||
    (phase !== CURSOR_PHASE.COLLECT && phase !== CURSOR_PHASE.VERIFY) ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 0 ||
    digest === undefined ||
    typeof collected !== "number" ||
    !Number.isSafeInteger(collected) ||
    collected < 0 ||
    (total !== null &&
      (typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0)) ||
    (snapshotId !== null && typeof snapshotId !== "string") ||
    (expectedDigest !== null && typeof expectedDigest !== "string") ||
    (phase === CURSOR_PHASE.COLLECT && expectedDigest !== null) ||
    (phase === CURSOR_PHASE.VERIFY && expectedDigest === null)
  ) {
    return undefined;
  }
  const base = { collected, digest, page, slice, snapshotId, total };
  if (phase === CURSOR_PHASE.COLLECT) {
    return { ...base, expectedDigest: null, phase };
  }
  if (typeof expectedDigest !== "string") {
    return undefined;
  }
  return { ...base, expectedDigest, phase };
};

const listingDigest = (
  previous: string,
  items: readonly FindokManifestItem[],
): string =>
  hashContent([previous, ...items.map((item) => item.dokumentId)].join("\n"));

const artifactUrl = (path: string): string => `${IWG_ROOT}/${path}`;

const buildListingOnly = (
  payload: FindokListingPayload,
  reason: string,
  rawXml?: string,
): IngestionResult => {
  const { item, collection } = payload;
  const decisionDate = parseDate(item.appdat);
  const sourceRaw = JSON.stringify({
    listing: payload,
    ...(rawXml === undefined ? {} : { documentXml: rawXml }),
  });
  return {
    sourceDocumentId: item.dokumentId,
    sourceDocumentIdRepairAliases: item.sourceDocumentIdRepairAliases,
    caseNumber: item.gz,
    isListingOnly: true,
    court: item.behoerde,
    country: COUNTRY,
    language: LANGUAGE,
    decisionDate,
    decisionType: item.dokumenttyp.toLocaleLowerCase("de-AT"),
    sourceUrl: artifactUrl(item.pathPdf),
    documentUrl: artifactUrl(item.pathPdf),
    metadata: {
      collection,
      stammNr: item.stammNr,
      title: item.titel,
      inFindokSince: item.inFindokSeitDate,
      detailStatus: reason,
      sourceAttribution: "Findok, Austrian Federal Ministry of Finance, CC0",
    },
    rawHash: hashContent(sourceRaw),
    documentAst: EMPTY_AST,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.AT_FINDOK],
    sourceRaw,
    sourceRawContentType: "application/json",
  };
};

type BuildDecisionOptions = {
  cursor: string | null;
  dependencies: AtFindokDependencies;
  payload: FindokListingPayload;
  signal?: AbortSignal | undefined;
};

const buildDecision = async ({
  cursor,
  dependencies,
  payload,
  signal,
}: BuildDecisionOptions): Promise<IngestionResult> => {
  const { item, collection } = payload;
  if (item.sourceDocumentIdRepairAliases === undefined) {
    return buildListingOnly(payload, "publisher-id-unavailable");
  }
  await dependencies.sleep(FINDOK_REQUEST_INTERVAL_MS);
  const response = await dependencies.request(
    artifactUrl(item.pathZip),
    { headers: { Accept: "application/zip" }, redirect: "error" },
    {
      adapterKey: ADAPTER_KEYS.AT_FINDOK,
      baseDelayMs: FINDOK_REQUEST_INTERVAL_MS,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    },
  );
  if (response.status === 404 || response.status === 410) {
    return buildListingOnly(payload, `detail-http-${response.status}`);
  }
  if (!response.ok || response.body === null) {
    throw new AdapterFetchError({
      message: `Findok detail request failed: ${response.status}`,
      adapterKey: ADAPTER_KEYS.AT_FINDOK,
      cursor,
      httpStatus: response.status,
    });
  }
  const compressed = await readStreamBounded(response.body, MAX_ARCHIVE_BYTES);
  const archive = await loadDocxArchive(compressed, {
    maxEntries: 20,
    maxEntryBytes: MAX_XML_BYTES,
    maxTotalBytes: MAX_XML_BYTES,
  });
  const entryPath = `Gesamt/${item.stammNr}.Entscheidungstext.xml`;
  const xml = await archive.readEntryString(entryPath);
  if (xml === null) {
    throw new AdapterFetchError({
      message: "Findok detail archive has no decision XML",
      adapterKey: ADAPTER_KEYS.AT_FINDOK,
      cursor,
    });
  }
  const decisionDate = parseDate(item.appdat);
  if (decisionDate === undefined) {
    panic("validated Findok manifest date became invalid");
  }
  const decisionType = item.dokumenttyp.toLocaleLowerCase("de-AT");
  let parsed: ReturnType<typeof parseFindokDecisionXml>;
  try {
    parsed = parseFindokDecisionXml({
      caseNumber: item.gz,
      court: item.behoerde,
      decisionDate,
      decisionType,
      sourceDocumentId: item.dokumentId,
      sourceUrl: artifactUrl(item.pathPdf),
      xml,
    });
  } catch {
    return buildListingOnly(payload, "detail-xml-unparseable", xml);
  }
  const sourceRaw = JSON.stringify({ listing: payload, documentXml: xml });
  return {
    sourceDocumentId: item.dokumentId,
    sourceDocumentIdRepairAliases: item.sourceDocumentIdRepairAliases,
    caseNumber: item.gz,
    ecli: parsed.ecli,
    court: item.behoerde,
    country: COUNTRY,
    language: LANGUAGE,
    decisionDate,
    decisionType,
    fulltext: parsed.fulltext,
    sourceUrl: artifactUrl(item.pathPdf),
    documentUrl: artifactUrl(item.pathPdf),
    metadata: {
      collection,
      ecli: parsed.ecli,
      court: item.behoerde,
      decisionDate,
      decisionType,
      stammNr: item.stammNr,
      title: item.titel,
      inFindokSince: item.inFindokSeitDate,
      statutes: parsed.statutes,
      keywords: parsed.keywords,
      sourceAttribution: "Findok, Austrian Federal Ministry of Finance, CC0",
    },
    rawHash: hashContent(sourceRaw),
    documentAst: parsed.documentAst,
    sections: sectionsFromAst(parsed.documentAst.blocks),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.AT_FINDOK],
    sourceRaw,
    sourceRawContentType: "application/json",
  };
};

const listReconciliationPage = async (
  loadManifest: ManifestLoader,
  { slice, page, signal }: ReconciliationSlicePageOptions,
): Promise<ReconciliationSlicePage> => {
  const parts = sliceParts(slice);
  if (parts === undefined || !Number.isSafeInteger(page) || page < 0) {
    throw new AdapterFetchError({
      message: `Invalid Findok reconciliation page: ${slice}/${page}`,
      adapterKey: ADAPTER_KEYS.AT_FINDOK,
      cursor: slice,
    });
  }
  const manifest = await loadManifest(parts.collection, signal);
  const items = itemsForSlice(manifest, parts.year);
  const start = page * RECONCILIATION_PAGE_SIZE;
  return {
    items: items.slice(start, start + RECONCILIATION_PAGE_SIZE).map((item) => ({
      identity: { type: "document", sourceDocumentId: item.dokumentId },
      payload: {
        collection: parts.collection,
        item,
      } satisfies FindokListingPayload,
    })),
    totalPages:
      items.length === 0
        ? 0
        : Math.ceil(items.length / RECONCILIATION_PAGE_SIZE),
  };
};

const parseListingPayload = (
  value: unknown,
): FindokListingPayload | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const collection = value["collection"];
  const item = manifestItem(value["item"]);
  return (collection === "bfg" || collection === "ufs") && item !== undefined
    ? { collection, item }
    : undefined;
};

export const createAtFindokAdapter = (
  dependencyOverrides: Partial<AtFindokDependencies> = {},
): SourceAdapter & { readonly key: typeof ADAPTER_KEYS.AT_FINDOK } => {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const loadManifest = createManifestLoader(dependencies);
  return defineSourceAdapter({
    key: ADAPTER_KEYS.AT_FINDOK,
    name: "Austrian Fiscal Courts (Findok BFG and UFS)",
    country: COUNTRY,
    language: LANGUAGE,
    minRequestIntervalMs: FINDOK_REQUEST_INTERVAL_MS,
    pageTimeoutMs: 10 * 60_000,
    maxCycleMs: 15 * 60_000,
    maxSyncPages: 1,

    reconciliation: {
      firstSlice: `${COLLECTIONS.ufs.firstYear}-ufs`,
      sliceOf: tipSlice,
      nextSlice: (slice) => atFindokNextSlice(slice, dependencies.now()),
      previousSlice: atFindokPreviousSlice,
      tipWindowDays: 3,
      listSlicePage: async (options) =>
        await listReconciliationPage(loadManifest, options),
      buildDecision: async (
        value,
        signal,
      ): Promise<ReconciliationBuildOutcome> => {
        const payload = parseListingPayload(value);
        if (payload === undefined) {
          return { type: "unkeyable" };
        }
        if (payload.item.sourceDocumentIdRepairAliases === undefined) {
          return { type: "detail-unavailable" };
        }
        const decision = await buildDecision({
          cursor: null,
          dependencies,
          payload,
          signal,
        });
        if (decision.isListingOnly !== true) {
          return { type: "built", decision };
        }
        const status = decision.metadata["detailStatus"];
        if (status === "detail-http-404" || status === "detail-http-410") {
          return { type: "detail-unavailable" };
        }
        throw new AdapterFetchError({
          message: `Findok reconciliation could not build detail: ${String(status)}`,
          adapterKey: ADAPTER_KEYS.AT_FINDOK,
          cursor: null,
        });
      },
    },

    async getTotalCount(signal) {
      try {
        const ufs = await loadManifest("ufs", signal);
        const bfg = await loadManifest("bfg", signal);
        return sourceTotalRead(ufs.items.length + bfg.items.length);
      } catch (error) {
        return { type: "probe-failed", errorTag: errorTag(error) };
      }
    },

    fetchPage: async (cursor, _config, signal) =>
      await Result.tryPromise({
        try: async () => {
          const state = decodeCursor(cursor, dependencies.now());
          if (state === undefined) {
            throw new AdapterFetchError({
              message: `Invalid Findok cursor: ${cursor}`,
              adapterKey: ADAPTER_KEYS.AT_FINDOK,
              cursor,
            });
          }
          const parts = sliceParts(state.slice);
          if (parts === undefined) {
            panic("validated Findok cursor has an invalid slice");
          }
          const manifest = await loadManifest(parts.collection, signal);
          if (
            state.snapshotId !== null &&
            state.snapshotId !== manifest.snapshotId
          ) {
            return {
              decisions: [],
              nextCursor: encodeCursor(cursorForSlice(state.slice)),
            };
          }
          const allItems = itemsForSlice(manifest, parts.year);
          const expectedTotal = state.total ?? allItems.length;
          if (expectedTotal !== allItems.length) {
            return {
              decisions: [],
              nextCursor: encodeCursor(cursorForSlice(state.slice)),
            };
          }
          if (allItems.length === 0) {
            const next = atFindokNextSlice(state.slice, dependencies.now());
            const nextState = cursorForSlice(
              next ?? tipSlice(dependencies.now()),
            );
            return {
              decisions: [],
              nextCursor: encodeCursor(nextState),
            };
          }
          const totalPages = Math.ceil(allItems.length / CRAWL_PAGE_SIZE);
          if (state.page >= totalPages) {
            throw new AdapterFetchError({
              message: "Findok cursor points past the manifest's last page",
              adapterKey: ADAPTER_KEYS.AT_FINDOK,
              cursor,
            });
          }
          const pageItems = allItems.slice(
            state.page * CRAWL_PAGE_SIZE,
            (state.page + 1) * CRAWL_PAGE_SIZE,
          );
          const digest = listingDigest(state.digest, pageItems);
          if (state.phase === CURSOR_PHASE.VERIFY) {
            if (state.page + 1 < totalPages) {
              return {
                decisions: [],
                nextCursor: encodeCursor({
                  ...state,
                  digest,
                  page: state.page + 1,
                  snapshotId: manifest.snapshotId,
                  total: expectedTotal,
                }),
              };
            }
            if (digest !== state.expectedDigest) {
              return {
                decisions: [],
                nextCursor: encodeCursor(cursorForSlice(state.slice)),
              };
            }
            const next = atFindokNextSlice(state.slice, dependencies.now());
            return {
              decisions: [],
              nextCursor: encodeCursor(
                cursorForSlice(next ?? tipSlice(dependencies.now())),
              ),
            };
          }

          const decisions = await Array.fromAsync(
            pageItems,
            async (item) =>
              await buildDecision({
                cursor,
                dependencies,
                payload: { collection: parts.collection, item },
                signal,
              }),
          );
          const collected = state.collected + decisions.length;
          if (state.page + 1 < totalPages) {
            return {
              decisions,
              nextCursor: encodeCursor({
                ...state,
                collected,
                digest,
                page: state.page + 1,
                snapshotId: manifest.snapshotId,
                total: expectedTotal,
              }),
            };
          }
          return {
            decisions,
            nextCursor: encodeCursor({
              collected,
              digest: START_DIGEST,
              expectedDigest: digest,
              page: 0,
              phase: CURSOR_PHASE.VERIFY,
              slice: state.slice,
              snapshotId: manifest.snapshotId,
              total: expectedTotal,
            }),
          };
        },
        catch: adapterCatch(ADAPTER_KEYS.AT_FINDOK, cursor),
      }),
  });
};

export const atFindokAdapter = createAtFindokAdapter();
