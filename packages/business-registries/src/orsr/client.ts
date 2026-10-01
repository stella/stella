import { Result } from "better-result";

import {
  hasOptionalNumber,
  hasOptionalNullableString,
  hasOptionalString,
  isRecord,
  isOptionalArrayOf,
} from "../shared/guards.js";
import {
  DEFAULT_REGISTRY_TIMEOUT_MS,
  performRegistryRequest,
  readRegistryJson,
  type RegistryClientOptions,
} from "../shared/http.js";
import { clampSearchLimit } from "../shared/search.js";
import {
  OrsrAPIError,
  OrsrError,
  OrsrRequestError,
  OrsrValidationError,
} from "./errors.js";
import {
  parseDocument,
  parseExtract,
  parseHistory,
  parseRelatedHit,
  parseSearchHit,
} from "./parse.js";
import type {
  OrsrCompany,
  OrsrDocument,
  OrsrFileReference,
  OrsrFullRecord,
  OrsrHistoryEntry,
  OrsrRawDocument,
  OrsrRawErrorResponse,
  OrsrRawExtractResponse,
  OrsrRawRelatedResponse,
  OrsrRawSearchHit,
  OrsrRawSearchResponse,
  OrsrRecordPart,
  OrsrRelatedLegalPerson,
  OrsrSearchResult,
} from "./types.js";
import { normalizeIco, validateIco } from "./validation.js";

const BASE = "https://sluzby.orsr.sk/api/legal-person";
const SEARCH_URL = BASE;
const EXTRACT_URL = `${BASE}/extract`;
const EXTRACT_FULL_URL = `${BASE}/extract-full`;
const DOCUMENTS_URL = `${BASE}/documents`;
const RELATED_URL = `${BASE}/related`;

// The search and the current extract keep the shared registry timeout. The
// history, document, and related-person requests are opt-in and larger (the
// full extract is several times the current one), so each gets a longer
// timeout; they run in parallel, which bounds the opt-in phase by it.
const PART_TIMEOUT_MS = 30_000;

const DEFAULT_SEARCH_LIMIT = 50;

// The search endpoint accepts a `Take` parameter but does not document
// a hard upper bound. Treat 100 as the safe ceiling so a runaway caller
// cannot ask for thousands of rows on the chat path.
const MAX_SEARCH_LIMIT = 100;

const isOrsrOptionalArrayOf = (
  value: unknown,
  isEntry: (entry: unknown) => boolean,
): boolean => value === null || isOptionalArrayOf(value, isEntry);

const isOrsrCodelistItem = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    hasOptionalNullableString(value, "itemCode") &&
    hasOptionalNullableString(value, "itemName"));

const isOrsrCodelistRef = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) && isOrsrCodelistItem(value["codelistItem"]));

const isOrsrWrappedCode = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    (typeof value["item"] === "string" ||
      (value["item"] !== null && isOrsrCodelistRef(value["item"]))));

const isOrsrTemporal = (value: unknown): boolean =>
  isRecord(value) &&
  hasOptionalNullableString(value, "effectiveFrom") &&
  hasOptionalNullableString(value, "effectiveTo") &&
  (value["current"] === undefined || typeof value["current"] === "boolean");

const isOrsrDelivery = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) && hasOptionalNullableString(value, "postalCode"));

const isOrsrAddress = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  ["streetName", "buildingNumber", "propertyRegistrationNumber"].every((key) =>
    hasOptionalNullableString(value, key),
  ) &&
  isOrsrWrappedCode(value["country"]) &&
  isOrsrWrappedCode(value["municipality"]) &&
  isOrsrDelivery(value["deliveryAddress"]);

const isOrsrIdentifier = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  hasOptionalNullableString(value, "identifierValue") &&
  isOrsrWrappedCode(value["identifierType"]);

const isOrsrValue = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  hasOptionalNullableString(value, "value");

const isOrsrLegalForm = (value: unknown): boolean =>
  isOrsrTemporal(value) && isRecord(value) && isOrsrCodelistRef(value["item"]);

const isOrsrEquity = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  hasOptionalNumber(value, "equityValue") &&
  hasOptionalNumber(value, "equityValuePaid") &&
  isOrsrWrappedCode(value["currency"]) &&
  ["equityValueSpecified", "equityValuePaidSpecified"].every(
    (key) => value[key] === undefined || typeof value[key] === "boolean",
  );

const isOrsrDeposit = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  (value["depositValue"] === null ||
    hasOptionalNumber(value, "depositValue")) &&
  (value["depositPayedValue"] === null ||
    hasOptionalNumber(value, "depositPayedValue")) &&
  isOrsrWrappedCode(value["currency"]) &&
  isOrsrOptionalArrayOf(value["stakeholder"], isOrsrValue);

const isOrsrPersonName = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) && hasOptionalNullableString(value, "formattedName"));

const isOrsrPhysicalPerson = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) && isOrsrPersonName(value["personName"]));

const isOrsrCorporatePerson = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    hasOptionalNullableString(value, "corporateBodyFullName"));

const isOrsrPersonData = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    (value["physicalPerson"] === null ||
      isOrsrPhysicalPerson(value["physicalPerson"])) &&
    (value["corporateBody"] === null ||
      isOrsrCorporatePerson(value["corporateBody"])) &&
    isOrsrOptionalArrayOf(value["physicalAddress"], isOrsrAddress) &&
    isOrsrOptionalArrayOf(value["id"], isOrsrIdentifier));

const isOrsrMember = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  ["function", "functionCreationDate", "functionTerminationDate"].every((key) =>
    hasOptionalNullableString(value, key),
  ) &&
  isOrsrPersonData(value["personData"]) &&
  isOrsrWrappedCode(value["stakeholderType"]);

const isOrsrLegalStatus = (value: unknown): boolean =>
  isOrsrTemporal(value) &&
  isRecord(value) &&
  hasOptionalNullableString(value, "text");

const isOrsrCorporateBody = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    hasOptionalNullableString(value, "establishment") &&
    (value["termination"] === null ||
      hasOptionalNullableString(value, "termination")) &&
    isOrsrOptionalArrayOf(value["corporateBodyFullName"], isOrsrValue) &&
    isOrsrOptionalArrayOf(value["legalForm"], isOrsrLegalForm) &&
    isOrsrOptionalArrayOf(value["equity"], isOrsrEquity) &&
    isOrsrOptionalArrayOf(value["deposits"], isOrsrDeposit) &&
    isOrsrOptionalArrayOf(value["statutoryBodyType"], isOrsrValue) &&
    isOrsrOptionalArrayOf(value["statutoryBody"], isOrsrMember) &&
    isOrsrOptionalArrayOf(value["authorizationToExecute"], isOrsrValue) &&
    isOrsrOptionalArrayOf(value["stakeholder"], isOrsrMember) &&
    isOrsrOptionalArrayOf(value["legalStatusEvents"], isOrsrLegalStatus));

const isOrsrLegalPerson = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    isOrsrCorporateBody(value["corporateBody"]) &&
    isOrsrOptionalArrayOf(value["physicalAddress"], isOrsrAddress) &&
    isOrsrOptionalArrayOf(value["id"], isOrsrIdentifier));

const isOrsrFileReference = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    hasOptionalNullableString(value, "section") &&
    hasOptionalNullableString(value, "court") &&
    (value["insertNumber"] === undefined ||
      typeof value["insertNumber"] === "string" ||
      typeof value["insertNumber"] === "number"));

const isOrsrSearchHit = (value: unknown): value is OrsrRawSearchHit =>
  isRecord(value) &&
  typeof value["id"] === "number" &&
  hasOptionalNullableString(value, "corporateBodyFullName") &&
  hasOptionalNullableString(value, "registrationNumber") &&
  hasOptionalNullableString(value, "physicalAddressLine1") &&
  hasOptionalNullableString(value, "physicalAddressLine2") &&
  isOrsrFileReference(value["fileReference"]);

const isOrsrSearchResponse = (value: unknown): value is OrsrRawSearchResponse =>
  isRecord(value) &&
  hasOptionalNumber(value, "filteredCount") &&
  isOrsrOptionalArrayOf(value["data"], isOrsrSearchHit);

const isOrsrExtractResponse = (
  value: unknown,
): value is OrsrRawExtractResponse =>
  isRecord(value) &&
  hasOptionalString(value, "courtName") &&
  isOrsrFileReference(value["fileReference"]) &&
  isOrsrLegalPerson(value["legalPerson"]);

const isOrsrDocumentList = (value: unknown): value is OrsrRawDocument[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isRecord(item) &&
      hasOptionalNumber(item, "serialNumber") &&
      hasOptionalString(item, "name") &&
      hasOptionalNumber(item, "type") &&
      hasOptionalString(item, "deliveryDate") &&
      hasOptionalNumber(item, "pageCount") &&
      (item["isElectronic"] === undefined ||
        typeof item["isElectronic"] === "boolean"),
  );

const isOrsrRelatedHit = (item: unknown): boolean =>
  isRecord(item) &&
  hasOptionalString(item, "corporateBodyFullName") &&
  hasOptionalString(item, "registrationNumber") &&
  hasOptionalString(item, "physicalAddressLine1") &&
  hasOptionalString(item, "physicalAddressLine2") &&
  (item["relatedPersonName"] === null ||
    hasOptionalString(item, "relatedPersonName")) &&
  isOrsrFileReference(item["fileReference"]);

const isOrsrRelatedResponse = (
  value: unknown,
): value is OrsrRawRelatedResponse =>
  isRecord(value) &&
  (value["data"] === undefined ||
    (Array.isArray(value["data"]) && value["data"].every(isOrsrRelatedHit)));

const parseErrorBody = (value: unknown): OrsrRawErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: OrsrRawErrorResponse = {};
  if (typeof value["title"] === "string") {
    result.title = value["title"];
  }
  if (isRecord(value["errors"])) {
    result.errors = value["errors"];
  }
  return result;
};

/** The timeout and caller cancellation of one request. */
type RequestContext = RegistryClientOptions & {
  timeoutMs: number;
  signal: AbortSignal | undefined;
};

type OrsrGetOptions<T> = {
  url: string;
  isExpectedShape: (value: unknown) => value is T;
  context: RequestContext;
};

const orsrGet = async <T>({
  url,
  isExpectedShape,
  context: { timeoutMs, signal, observer },
}: OrsrGetOptions<T>): Promise<T> => {
  const response = await performRegistryRequest({
    url,
    observer,
    init: { headers: { Accept: "application/json" } },
    signal,
    timeoutMs,
    wrapRequestError: (cause) =>
      new OrsrRequestError(url, "ORSR request failed", { cause }),
  });

  if (!response.ok) {
    let body: OrsrRawErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON body
    }
    throw new OrsrAPIError({
      message: `ORSR ${response.status}: ${body.title ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage: body.title ?? null,
    });
  }

  // An outage page served with HTTP 200 is HTML, so it fails here as an
  // invalid JSON payload rather than parsing as an empty record.
  return readRegistryJson({
    response,
    signal,
    isExpectedShape,
    wrapParseError: (cause) =>
      new OrsrAPIError({
        message: `ORSR ${response.status}: invalid JSON payload`,
        httpStatus: response.status,
        upstreamMessage: null,
        cause,
      }),
    wrapShapeError: () =>
      new OrsrAPIError({
        message: `ORSR ${response.status}: unexpected JSON payload shape`,
        httpStatus: response.status,
        upstreamMessage: null,
      }),
  });
};

const buildSearchUrl = (filterValue: string, take?: number): string => {
  const params = new URLSearchParams();
  params.set("Filter.IncludeTerminated", "true");
  params.set("Filter.CorporateBodyFullNameOrRegistrationNumber", filterValue);
  if (take !== undefined) {
    params.set("Take", String(take));
  }
  return `${SEARCH_URL}?${params.toString()}`;
};

const fileUrl = (base: string, file: OrsrFileReference): string =>
  `${base}?${new URLSearchParams({
    oddiel: file.section,
    vlozka: file.insertNumber,
    sud: file.court,
  }).toString()}`;

const pickLatestHit = (
  hits: OrsrRawSearchHit[] | undefined,
  ico: string,
): OrsrRawSearchHit | null => {
  // The search filter matches the corporate name as well as the
  // registration number, so a company whose name contains these digits is
  // also a hit. Only exact IČO matches are candidates.
  const matching = (hits ?? []).filter(
    // The response guard only checks `id`, so a null or non-string
    // registration number must be excluded here, not normalized.
    (hit) =>
      typeof hit.registrationNumber === "string" &&
      normalizeIco(hit.registrationNumber) === ico,
  );
  // Re-registrations preserve the IČO but mint a fresh internal `id`;
  // the highest internal id is the live record (or, for terminated
  // entities, the final registry state).
  return matching.toSorted((a, b) => b.id - a.id).at(0) ?? null;
};

const dedupeLatestHitsByIco = (
  hits: OrsrRawSearchHit[] | undefined,
): OrsrRawSearchHit[] => {
  if (!hits || hits.length === 0) {
    return [];
  }

  const latestByIco = new Map<string, OrsrRawSearchHit>();
  for (const hit of hits) {
    const ico = hit.registrationNumber?.trim();
    if (!ico) {
      continue;
    }
    const previous = latestByIco.get(ico);
    if (!previous || hit.id > previous.id) {
      latestByIco.set(ico, hit);
    }
  }

  const seen = new Set<string>();
  const deduped: OrsrRawSearchHit[] = [];
  for (const hit of hits) {
    const ico = hit.registrationNumber?.trim();
    if (!ico) {
      deduped.push(hit);
      continue;
    }
    if (seen.has(ico) || latestByIco.get(ico) !== hit) {
      continue;
    }
    seen.add(ico);
    deduped.push(hit);
  }
  return deduped;
};

/**
 * Resolve an IČO to its trade-register file (`oddiel` / `vlozka` / `sud`)
 * through the search endpoint, or `null` when no filed record carries it.
 */
const findFileByIco = async (
  ico: string,
  context: RequestContext,
): Promise<OrsrFileReference | null> => {
  const searchData = await orsrGet({
    url: buildSearchUrl(ico),
    isExpectedShape: isOrsrSearchResponse,
    context,
  });
  const fileRef = pickLatestHit(searchData.data, ico)?.fileReference;
  if (
    !fileRef?.section ||
    fileRef.insertNumber === undefined ||
    !fileRef.court
  ) {
    return null;
  }
  return {
    section: fileRef.section,
    insertNumber: String(fileRef.insertNumber),
    court: fileRef.court,
  };
};

const validatedIco = (input: string): string => {
  const normalized = normalizeIco(input);
  if (!validateIco(normalized)) {
    throw new OrsrValidationError(`Invalid Slovak IČO: ${input}`);
  }
  return normalized;
};

// The extract is fetched by file reference, not by IČO. A record naming a
// different entity means the registry holds no record for this IČO at that
// reference, so it is reported as not on file rather than returned.
const companyForIco = (
  extract: OrsrRawExtractResponse,
  ico: string,
): OrsrCompany | null => {
  const company = parseExtract(extract);
  return company !== null && normalizeIco(company.ico) === ico ? company : null;
};

const fetchExtract = async (
  file: OrsrFileReference,
  context: RequestContext,
): Promise<OrsrRawExtractResponse> =>
  await orsrGet({
    url: fileUrl(EXTRACT_URL, file),
    isExpectedShape: isOrsrExtractResponse,
    context,
  });

const fetchHistory = async (
  file: OrsrFileReference,
  context: RequestContext,
): Promise<OrsrHistoryEntry[]> =>
  parseHistory(
    await orsrGet({
      url: fileUrl(EXTRACT_FULL_URL, file),
      isExpectedShape: isOrsrExtractResponse,
      context,
    }),
  );

const fetchDocuments = async (
  file: OrsrFileReference,
  context: RequestContext,
): Promise<OrsrDocument[]> => {
  const documents = await orsrGet({
    url: fileUrl(DOCUMENTS_URL, file),
    isExpectedShape: isOrsrDocumentList,
    context,
  });
  return documents.map(parseDocument).filter((document) => document !== null);
};

const fetchRelated = async (
  file: OrsrFileReference,
  context: RequestContext,
): Promise<OrsrRelatedLegalPerson[]> => {
  const related = await orsrGet({
    url: fileUrl(RELATED_URL, file),
    isExpectedShape: isOrsrRelatedResponse,
    context,
  });
  return (related.data ?? [])
    .map(parseRelatedHit)
    .filter((person) => person !== null);
};

// A supplementary part that the register fails to serve is reported as
// unavailable with the adapter error's message; anything that is not an
// adapter error (caller cancellation, a defect) still propagates.
const settlePart = async <Value>(
  pending: Promise<Value>,
): Promise<OrsrRecordPart<Value>> => {
  const settled = await Result.tryPromise({
    try: async () => await pending,
    catch: (error) => error,
  });
  if (settled.isOk()) {
    return { status: "loaded", value: settled.value };
  }
  if (settled.error instanceof OrsrError) {
    return { status: "unavailable", reason: settled.error.message };
  }
  throw settled.error;
};

/**
 * Look up a Slovak entity by IČO. Implements the two-step contract
 * the Ministry of Justice's JSON API requires:
 *
 *   1. Search by IČO to obtain the trade-register file reference
 *      (`oddiel` / `vlozka` / `sud`).
 *   2. Fetch the full record from `/extract` using that reference.
 *
 * The search step uses `Filter.IncludeTerminated=true` so historical
 * (struck-off) entities still resolve; the parser surfaces the
 * terminated status via `OrsrCompany.status`.
 *
 * @returns The entity, or `null` if the IČO is not on file (including when
 *   the fetched extract names a different IČO).
 * @throws {OrsrValidationError} when the IČO fails MOD-11
 * @throws {OrsrAPIError} on upstream HTTP errors or a non-JSON body
 * @throws {OrsrRequestError} on network failures and timeouts
 */
export const lookupByIco = async (
  ico: string,
  options: RegistryClientOptions,
): Promise<OrsrCompany | null> => {
  const normalized = validatedIco(ico);
  const context = { ...options, timeoutMs: DEFAULT_REGISTRY_TIMEOUT_MS };
  const file = await findFileByIco(normalized, context);
  if (!file) {
    return null;
  }
  return companyForIco(await fetchExtract(file, context), normalized);
};

/**
 * Look up a Slovak entity by IČO with everything the register files about
 * it: the current extract, the superseded entries of the full extract, the
 * collection of deeds, and the related legal persons. After the IČO search
 * the four requests run in parallel. It costs three requests more than
 * {@link lookupByIco}, so callers ask for it explicitly.
 *
 * The current extract is required; a history, document, or related-person
 * request that fails is reported as an unavailable part of the record.
 *
 * @returns The record, or `null` if the IČO is not on file.
 * @throws {OrsrValidationError} when the IČO fails MOD-11
 * @throws {OrsrAPIError} when the search or the extract fails upstream
 * @throws {OrsrRequestError} on network failures and timeouts of either
 */
export const lookupFullRecordByIco = async (
  ico: string,
  options: RegistryClientOptions,
): Promise<OrsrFullRecord | null> => {
  const normalized = validatedIco(ico);
  const signal = options.signal;
  const core = {
    observer: options.observer,
    timeoutMs: DEFAULT_REGISTRY_TIMEOUT_MS,
    signal,
  };
  const file = await findFileByIco(normalized, core);
  if (!file) {
    return null;
  }
  const parts = {
    observer: options.observer,
    timeoutMs: PART_TIMEOUT_MS,
    signal,
  };
  const [extract, history, documents, related] = await Promise.all([
    fetchExtract(file, core),
    settlePart(fetchHistory(file, parts)),
    settlePart(fetchDocuments(file, parts)),
    settlePart(fetchRelated(file, parts)),
  ]);
  const company = companyForIco(extract, normalized);
  return company ? { company, history, documents, related } : null;
};

export type SearchOptions = RegistryClientOptions & {
  /** Maximum number of results. Clamped to the adapter ceiling (100). @default 50 */
  limit?: number;
};

/**
 * Search the Slovak Obchodný register by company name. Uses the same
 * search endpoint as the canonical-ID step, with `Take` controlling the
 * page size.
 *
 * @returns A list of matching entities (may be empty).
 * @throws {OrsrValidationError} if `name` is empty after trimming
 * @throws {OrsrAPIError} on upstream HTTP errors or a non-JSON body
 * @throws {OrsrRequestError} on network failures and timeouts
 */
export const searchByName = async (
  name: string,
  options: SearchOptions,
): Promise<OrsrSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new OrsrValidationError("Search name must not be empty");
  }
  const requestedLimit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const take = clampSearchLimit(requestedLimit, MAX_SEARCH_LIMIT);
  const searchTake = Math.min(
    Math.max(take, DEFAULT_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT,
  );
  const data = await orsrGet({
    url: buildSearchUrl(trimmed, searchTake),
    isExpectedShape: isOrsrSearchResponse,
    context: { ...options, timeoutMs: DEFAULT_REGISTRY_TIMEOUT_MS },
  });
  return dedupeLatestHitsByIco(data.data).slice(0, take).map(parseSearchHit);
};
