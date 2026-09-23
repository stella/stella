import { panic, Result } from "better-result";

import { Temporal, parsePlainDate } from "@stll/time";
import { isUuid } from "@stll/uuid-codec";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceAdapter,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
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
import {
  listFindokDocumentFields,
  parseFindokDecisionXml,
  parseFindokHeadnoteXml,
} from "@/api/handlers/case-law/ingestion/parsers/at-findok";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  sourceTextField,
} from "@/api/lib/case-law/decision-text";
import type { DecisionTextFields } from "@/api/lib/case-law/decision-text";
import { loadDocxArchive } from "@/api/lib/docx-archive";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { isRecord } from "@/api/lib/type-guards";

const FINDOK_ORIGIN = "https://findok.bmf.gv.at";
const IWG_ROOT = `${FINDOK_ORIGIN}/findok/iwg`;
const LANGUAGE = "de";
const CRAWL_PAGE_SIZE = 10;
const RECONCILIATION_PAGE_SIZE = 100;
const MANIFEST_CACHE_MS = 15 * 60_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 12 * 1024 * 1024;
const START_DIGEST = "start";
const QUARANTINE_ID_PREFIX = "findok-quarantine:";
const SOURCE_FIRST_YEAR = Number.parseInt(
  ADAPTER_MANIFESTS[ADAPTER_KEYS.AT_FINDOK].dateRange.fromInclusive.slice(0, 4),
  10,
);

/** The envelope part each payload of a decision is stored under. */
const FINDOK_PART = {
  LISTING: "listing",
  DOCUMENT_XML: "document-xml",
  HEADNOTE_XML: "headnote-xml",
} as const;

const COLLECTIONS = {
  bfg: {
    authority: "BFG",
    firstYear: 2014,
    manifestUrl: `${IWG_ROOT}/bestandsliste-bfg.gz`,
  },
  ufs: {
    authority: "UFS",
    firstYear: SOURCE_FIRST_YEAR,
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
  gueltigAb: string | undefined;
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
  return parsePlainDate(
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  )?.toString();
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
    gueltigAb: optionalString(value["gueltigAb"]),
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
    gueltigAb: item.gueltigAb,
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

const tipSlice = (now: Date): string =>
  `${Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO("UTC").year}-bfg`;

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

/** Every payload fetched for one decision, under the name its role has. */
type FindokStoredParts = {
  item: FindokManifestItem;
  documentXml?: string | undefined;
  headnoteXml?: string | undefined;
};

const storedRaw = ({
  item,
  documentXml,
  headnoteXml,
}: FindokStoredParts): {
  sourceRaw: string;
  sourceRawContentType: string;
} => ({
  sourceRaw: encodeSourceRawEnvelope({
    // The manifest row verbatim, not the adapter's own wrapper around it: a
    // reader of a stored row can then tell which response it is holding.
    [FINDOK_PART.LISTING]: JSON.stringify(item.raw),
    ...(documentXml === undefined
      ? {}
      : { [FINDOK_PART.DOCUMENT_XML]: documentXml }),
    ...(headnoteXml === undefined
      ? {}
      : { [FINDOK_PART.HEADNOTE_XML]: headnoteXml }),
  }),
  sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
});

const buildListingOnly = (
  payload: FindokListingPayload,
  reason: string,
  rawXml?: string,
): IngestionResult => {
  const { item, collection } = payload;
  const decisionDate = parseDate(item.appdat);
  const raw = storedRaw({ item, documentXml: rawXml });
  return {
    sourceDocumentId: item.dokumentId,
    sourceDocumentIdRepairAliases: item.sourceDocumentIdRepairAliases,
    caseNumber: item.gz,
    isListingOnly: true,
    court: item.behoerde,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.AT_FINDOK].country,
    language: LANGUAGE,
    decisionDate,
    decisionType: item.dokumenttyp.toLocaleLowerCase("de-AT"),
    sourceUrl: artifactUrl(item.pathPdf),
    documentUrl: artifactUrl(item.pathPdf),
    // The manifest states a subject line for every row, so even a row whose
    // archive never opened carries the publisher's own summary of it.
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      summary: sourceTextField(ADAPTER_KEYS.AT_FINDOK, item.titel),
    },
    metadata: {
      collection,
      stammNr: item.stammNr,
      archivePath: item.pathZip,
      validFrom: item.gueltigAb,
      inFindokSince: item.inFindokSeitDate,
      detailStatus: reason,
      sourceAttribution: "Findok, Austrian Federal Ministry of Finance, CC0",
    },
    rawHash: hashContent(raw.sourceRaw),
    documentAst: EMPTY_AST,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.AT_FINDOK],
    ...raw,
  };
};

type FindokTextFieldsOptions = {
  readonly betreff: string | undefined;
  /** Whether the archive carried a headnote entry at all. */
  readonly headnoteEntryRead: boolean;
  readonly legalSentence: string | undefined;
};

/**
 * What this publisher itself wrote about the decision.
 *
 * Two of the four are real here: the subject line it prints over every
 * document, and the legal sentences it files as a document of their own. A
 * headnote entry that was read and could not be parsed is stated as such
 * rather than as a decision the ministry wrote no sentence for.
 */
const decisionTextFields = ({
  betreff,
  headnoteEntryRead,
  legalSentence,
}: FindokTextFieldsOptions): DecisionTextFields => ({
  ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  summary: sourceTextField(ADAPTER_KEYS.AT_FINDOK, betreff),
  legalSentence:
    headnoteEntryRead && legalSentence === undefined
      ? absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED)
      : sourceTextField(ADAPTER_KEYS.AT_FINDOK, legalSentence),
});

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
  const { item } = payload;
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
  // The same archive carries the decision's headnotes as a second entry. It
  // is already paid for by the request above, and its element names are not
  // the ones the decision text uses, which is why reading it is a step of its
  // own rather than a second call to the same parser.
  const headnoteXml = await archive.readEntryString(
    `Gesamt/${item.stammNr}.Rechtssaetze.xml`,
  );
  return assembleAtFindokDecision(payload, {
    documentXml: xml,
    headnoteXml: headnoteXml ?? undefined,
  });
};

/** The archive entries this service serves for one decision. */
export type AtFindokDecisionPayloads = {
  readonly documentXml: string;
  /** The headnote entry, where the archive carried one. */
  readonly headnoteXml?: string | undefined;
};

/**
 * Build one decision from the entries the archive carried.
 *
 * Split from the fetching above so the row a crawl writes and the row built
 * from stored entries are the same row.
 */
export const assembleAtFindokDecision = (
  payload: FindokListingPayload,
  { documentXml, headnoteXml }: AtFindokDecisionPayloads,
): IngestionResult => {
  const { item, collection } = payload;
  const decisionDate = parseDate(item.appdat);
  if (decisionDate === undefined) {
    panic("validated Findok manifest date became invalid");
  }
  const decisionType = item.dokumenttyp.toLocaleLowerCase("de-AT");
  const parseResult = parseFindokDecisionXml({
    caseNumber: item.gz,
    court: item.behoerde,
    decisionDate,
    decisionType,
    sourceDocumentId: item.dokumentId,
    sourceUrl: artifactUrl(item.pathPdf),
    xml: documentXml,
  });
  if (Result.isError(parseResult)) {
    return buildListingOnly(payload, "detail-xml-unparseable", documentXml);
  }
  const parsed = parseResult.value;
  const headnotes =
    headnoteXml === undefined ? undefined : parseFindokHeadnoteXml(headnoteXml);
  const raw = storedRaw({ item, documentXml, headnoteXml });
  return {
    sourceDocumentId: item.dokumentId,
    sourceDocumentIdRepairAliases: item.sourceDocumentIdRepairAliases,
    caseNumber: item.gz,
    ecli: parsed.ecli,
    court: item.behoerde,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.AT_FINDOK].country,
    language: LANGUAGE,
    decisionDate,
    decisionType,
    fulltext: parsed.fulltext,
    sourceUrl: artifactUrl(item.pathPdf),
    documentUrl: artifactUrl(item.pathPdf),
    textFields: decisionTextFields({
      betreff: parsed.betreff ?? item.titel,
      headnoteEntryRead: headnoteXml !== undefined,
      legalSentence: headnotes?.legalSentence,
    }),
    metadata: {
      collection,
      ecli: parsed.ecli,
      court: item.behoerde,
      decisionDate,
      decisionType,
      stammNr: item.stammNr,
      archivePath: item.pathZip,
      validFrom: item.gueltigAb,
      validUntil: parsed.envelope.validUntil,
      officiallyPublished: parsed.envelope.officiallyPublished,
      originalCaseNumber: parsed.envelope.originalCaseNumber,
      versionNumber: parsed.envelope.versionNumber,
      findokGid: parsed.envelope.globalId,
      modified: parsed.envelope.lastChangedAt,
      published: parsed.envelope.publishedAt,
      inFindokSince: item.inFindokSeitDate,
      statutes: parsed.statutes,
      keywords: parsed.keywords,
      subjectCodes: parsed.subjectCodes,
      headnoteNumbers: headnotes?.headnoteNumbers,
      headnoteStatutes: headnotes?.statutes,
      sourceAttribution: "Findok, Austrian Federal Ministry of Finance, CC0",
    },
    rawHash: hashContent(raw.sourceRaw),
    documentAst: parsed.documentAst,
    sections: sectionsFromAst(parsed.documentAst.blocks),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.AT_FINDOK],
    ...raw,
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

/**
 * Every payload this service serves for one decision, and whether the row
 * keeps it.
 *
 * The crawl reads a manifest row and the archive the row points at, and the
 * archive holds two documents: the decision text and the headnotes filed with
 * it. All three are kept as named parts, so a reader of a stored row can tell
 * which response it is holding and a field captured later is recoverable
 * without asking the ministry again.
 */
const SOURCE_SURFACES = [
  "listing",
  "document-zip",
  "document-xml",
  "headnote-xml",
  "document-pdf",
  "web-document",
] as const;

const AT_FINDOK_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(FINDOK_PART.LISTING),
    "document-zip": excludedSourceSurface(
      "the archive is the transport for the document entries below; the entries are the payloads",
    ),
    "document-xml": storedSourceSurface(FINDOK_PART.DOCUMENT_XML),
    "headnote-xml": storedSourceSurface(FINDOK_PART.HEADNOTE_XML),
    "document-pdf": excludedSourceSurface(
      "a heavier rendition of the same text the archive's document entry states",
    ),
    "web-document": excludedSourceSurface(
      "its address carries a session-flow token, so it cannot be constructed, and the page blends material from other publishers",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

/**
 * Every field this service states for a decision, across its three payloads.
 *
 * The manifest row is spelled in this service's own JSON keys; both archive
 * entries are spelled as the element's group and name, because the decision
 * text and the headnotes share one envelope and differ only in the body
 * element each of them fills.
 */
const FINDOK_SOURCE_FIELDS_LIST = [
  "appdat",
  "behoerde",
  "dokumentId",
  "dokumenttyp",
  "gueltig",
  "gueltigAb",
  "gz",
  "inFindokSeit",
  "inFindokSeitDate",
  "pathPdf",
  "pathZip",
  "stammNr",
  "titel",
  "Grundk/appdat",
  "Grundk/appdatbis",
  "Grundk/av_veroeffentlicht",
  "Grundk/behoerde",
  "Grundk/betreff",
  "Grundk/doktyptxt",
  "Grundk/ecli",
  "Grundk/erstfass",
  "Grundk/fsgnr",
  "Grundk/gid",
  "Grundk/gz",
  "Grundk/lastchangedat",
  "Grundk/matbez_erf",
  "Grundk/matnr_erf",
  "Grundk/ngesamt_erf",
  "Grundk/stammnr",
  "Grundk/uebersex_net",
  "Grundk/vadat",
  "Segk/dok_fassungsnr",
  "Segk/dokformat",
  "Segk/fsgnr",
  "Segk/gid",
  "Segk/id_multifassung",
  "Segk/inkraftvon",
  "Segk/lastchangedat",
  "Segk/neuzdat",
  "Segk/ngesamt",
  "Segk/rsnr",
  "Segk/segbez",
  "Segk/segnr2",
  "Segk/txt",
  "Segk/txtascii",
] as const;

type FindokSourceField = (typeof FINDOK_SOURCE_FIELDS_LIST)[number];

const SEGMENT_BOOKKEEPING = excludedSourceField(
  "the archive's own segmentation of one document into versioned pieces, which the row stores whole",
);

const FINDOK_SOURCE_FIELDS = {
  appdat: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  behoerde: { disposition: "stored", target: { type: "result", key: "court" } },
  dokumentId: { disposition: "stored", target: { type: "identity" } },
  dokumenttyp: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  gueltig: excludedSourceField(
    "the service's own inventory flag: a row it marks invalid is never ingested, so every stored row would carry the same value",
  ),
  gueltigAb: {
    disposition: "stored",
    target: { type: "metadata", key: "validFrom" },
  },
  gz: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  inFindokSeit: excludedSourceField(
    "a rendering of the timestamp the row states beside it in a sortable form",
  ),
  inFindokSeitDate: {
    disposition: "stored",
    target: { type: "metadata", key: "inFindokSince" },
  },
  pathPdf: {
    disposition: "stored",
    target: { type: "result", key: "documentUrl" },
  },
  pathZip: {
    disposition: "stored",
    target: { type: "metadata", key: "archivePath" },
  },
  stammNr: {
    disposition: "stored",
    target: { type: "metadata", key: "stammNr" },
  },
  titel: {
    disposition: "stored",
    target: { type: "textField", key: "summary" },
  },
  "Grundk/appdat": excludedSourceField(
    "the manifest row states the decision date",
  ),
  "Grundk/appdatbis": {
    disposition: "stored",
    target: { type: "metadata", key: "validUntil" },
  },
  "Grundk/av_veroeffentlicht": {
    disposition: "stored",
    target: { type: "metadata", key: "officiallyPublished" },
  },
  "Grundk/behoerde": excludedSourceField(
    "the manifest row states the deciding authority",
  ),
  "Grundk/betreff": {
    disposition: "stored",
    target: { type: "textField", key: "summary" },
  },
  "Grundk/doktyptxt": excludedSourceField(
    "the manifest row states the same decision type",
  ),
  "Grundk/ecli": {
    disposition: "stored",
    target: { type: "result", key: "ecli" },
  },
  "Grundk/erstfass": {
    disposition: "stored",
    target: { type: "metadata", key: "originalCaseNumber" },
  },
  "Grundk/fsgnr": {
    disposition: "stored",
    target: { type: "metadata", key: "versionNumber" },
  },
  "Grundk/gid": {
    disposition: "stored",
    target: { type: "metadata", key: "findokGid" },
  },
  "Grundk/gz": excludedSourceField("the manifest row states the docket"),
  "Grundk/lastchangedat": {
    disposition: "stored",
    target: { type: "metadata", key: "modified" },
  },
  "Grundk/matbez_erf": {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
  "Grundk/matnr_erf": {
    disposition: "stored",
    target: { type: "metadata", key: "subjectCodes" },
  },
  "Grundk/ngesamt_erf": {
    disposition: "stored",
    target: { type: "metadata", key: "statutes" },
  },
  "Grundk/stammnr": excludedSourceField(
    "the manifest row states the same serial, which is also the archive's entry name",
  ),
  "Grundk/uebersex_net": {
    disposition: "stored",
    target: { type: "document" },
  },
  "Grundk/vadat": {
    disposition: "stored",
    target: { type: "metadata", key: "published" },
  },
  "Segk/dok_fassungsnr": SEGMENT_BOOKKEEPING,
  "Segk/dokformat": excludedSourceField(
    "the media type of the body element beside it, which is the one this parser reads",
  ),
  "Segk/fsgnr": SEGMENT_BOOKKEEPING,
  "Segk/gid": SEGMENT_BOOKKEEPING,
  "Segk/id_multifassung": SEGMENT_BOOKKEEPING,
  "Segk/inkraftvon": SEGMENT_BOOKKEEPING,
  "Segk/lastchangedat": SEGMENT_BOOKKEEPING,
  "Segk/neuzdat": SEGMENT_BOOKKEEPING,
  "Segk/ngesamt": {
    disposition: "stored",
    target: { type: "metadata", key: "headnoteStatutes" },
  },
  "Segk/rsnr": {
    disposition: "stored",
    target: { type: "metadata", key: "headnoteNumbers" },
  },
  "Segk/segbez": SEGMENT_BOOKKEEPING,
  "Segk/segnr2": SEGMENT_BOOKKEEPING,
  "Segk/txt": { disposition: "stored", target: { type: "document" } },
  "Segk/txtascii": {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
} as const satisfies Record<FindokSourceField, SourceFieldDisposition>;

/** Every field the stored envelope states, read from the payloads themselves. */
const listFindokSourceFields = (parts: SourceRawParts): readonly string[] => {
  const names = new Set<string>();
  const row: unknown = JSON.parse(parts[FINDOK_PART.LISTING] ?? "null");
  if (isRecord(row)) {
    for (const key of Object.keys(row)) {
      names.add(key);
    }
  }
  for (const part of [FINDOK_PART.DOCUMENT_XML, FINDOK_PART.HEADNOTE_XML]) {
    const xml = parts[part];
    if (xml === undefined) {
      continue;
    }
    for (const field of listFindokDocumentFields(xml)) {
      names.add(field);
    }
  }
  return [...names];
};

export const createAtFindokAdapter = (
  dependencyOverrides: Partial<AtFindokDependencies> = {},
): SourceAdapter & { readonly key: typeof ADAPTER_KEYS.AT_FINDOK } => {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const loadManifest = createManifestLoader(dependencies);
  return defineSourceAdapter({
    key: ADAPTER_KEYS.AT_FINDOK,
    sourceSurfaces: AT_FINDOK_SOURCE_SURFACES,
    sourceFields: {
      status: "declared",
      fields: FINDOK_SOURCE_FIELDS,
      listSourceFields: listFindokSourceFields,
    },
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
              message: `Invalid Findok cursor: ${cursor ?? "(none)"}`,
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
