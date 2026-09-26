import { Result } from "better-result";

import { isRecord } from "../shared/guards.js";
import {
  performRegistryRequest,
  readRegistryJson,
  type RegistryClientOptions,
} from "../shared/http.js";
import { clampSearchLimit } from "../shared/search.js";
import { RpoAPIError, RpoRequestError, RpoValidationError } from "./errors.js";
import { parseEntity, parseSearchHit } from "./parse.js";
import type {
  RpoEntity,
  RpoRawEntity,
  RpoRawSearchHit,
  RpoRawSearchResponse,
  RpoSearchResult,
  RpoView,
} from "./types.js";
import { isIcoShape, normalizeIco } from "./validation.js";

const BASE = "https://api.statistics.sk/rpo/v1";
const SEARCH_URL = `${BASE}/search`;
const ENTITY_URL = `${BASE}/entity`;

// Searches took up to eight seconds when probed, and one was held open for
// more than forty, so the shared ten-second default would cut off ordinary
// answers.
const REQUEST_TIMEOUT_MS = 30_000;

// The search endpoint has no page-size parameter and returns every match, so
// the limit is applied to the ranked result list.
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;

// Record lists may be absent; when present, every entry is an object.
const isOptionalRecordList = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every(isRecord));

const isRpoSearchHit = (value: unknown): value is RpoRawSearchHit =>
  isRecord(value) &&
  typeof value["id"] === "number" &&
  isOptionalRecordList(value["identifiers"]) &&
  isOptionalRecordList(value["fullNames"]) &&
  isOptionalRecordList(value["addresses"]);

const isRpoSearchResponse = (value: unknown): value is RpoRawSearchResponse =>
  isRecord(value) &&
  Array.isArray(value["results"]) &&
  value["results"].every(isRpoSearchHit);

const ENTITY_LIST_FIELDS = [
  "legalForms",
  "legalStatuses",
  "activities",
  "statutoryBodies",
  "stakeholders",
  "authorizations",
  "equities",
  "predecessors",
  "successors",
] as const;

const isRpoEntity = (value: unknown): value is RpoRawEntity =>
  isRecord(value) &&
  ENTITY_LIST_FIELDS.every((field) => isOptionalRecordList(value[field])) &&
  isRpoSearchHit(value);

// The guards check the record structure; a payload whose leaf fields break the
// parser still surfaces as an upstream error, never an internal one.
const parseUpstream = <T>(parse: () => T): T => {
  const parsed = Result.try(parse);
  if (parsed.isErr()) {
    throw new RpoAPIError({
      message: "RPO 200: unexpected JSON payload shape",
      httpStatus: 200,
      cause: parsed.error,
    });
  }
  return parsed.value;
};

const readErrorMessage = async (
  response: Response,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  const body = await Result.tryPromise({
    try: async (): Promise<unknown> => await response.json(),
    catch: (cause) => cause,
  });
  if (body.isErr()) {
    signal?.throwIfAborted();
    // Outage pages and proxies answer with HTML; the status is the signal.
    return null;
  }
  return isRecord(body.value) && typeof body.value["message"] === "string"
    ? body.value["message"]
    : null;
};

/** GET a JSON resource. Resolves to `null` on 404 (no such record). */
const rpoGet = async <T>(
  url: string,
  isExpectedShape: (value: unknown) => value is T,
  signal: AbortSignal | undefined,
): Promise<T | null> => {
  const response = await performRegistryRequest({
    url,
    init: { headers: { Accept: "application/json" } },
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    wrapRequestError: (cause) =>
      new RpoRequestError(url, "RPO request failed", { cause }),
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const upstreamMessage = await readErrorMessage(response, signal);
    throw new RpoAPIError({
      message: `RPO ${response.status}: ${upstreamMessage ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage,
    });
  }

  // An outage page served with HTTP 200 is HTML and fails here as an invalid
  // JSON payload.
  return readRegistryJson({
    response,
    signal,
    isExpectedShape,
    wrapParseError: (cause) =>
      new RpoAPIError({
        message: `RPO ${response.status}: invalid JSON payload`,
        httpStatus: response.status,
        cause,
      }),
    wrapShapeError: () =>
      new RpoAPIError({
        message: `RPO ${response.status}: unexpected JSON payload shape`,
        httpStatus: response.status,
      }),
  });
};

const search = async (
  params: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<RpoRawSearchHit[]> => {
  const url = `${SEARCH_URL}?${new URLSearchParams(params).toString()}`;
  const response = await rpoGet(url, isRpoSearchResponse, signal);
  if (response === null) {
    throw new RpoAPIError({
      message: "RPO 404: no search endpoint",
      httpStatus: 404,
    });
  }
  return response.results;
};

const carriesIco = (hit: RpoRawSearchHit, ico: string): boolean =>
  (hit.identifiers ?? []).some(
    (identifier) =>
      typeof identifier.value === "string" &&
      normalizeIco(identifier.value) === ico,
  );

// An IČO can sit on more than one record (a body re-registered in another
// source register keeps its number). Prefer the record still in existence,
// then the most recently created one.
const pickRecordForIco = (
  hits: RpoRawSearchHit[],
  ico: string,
): RpoRawSearchHit | null =>
  hits
    .filter((hit) => carriesIco(hit, ico))
    .toSorted((a, b) => {
      const aEnded = a.termination === undefined ? 0 : 1;
      const bEnded = b.termination === undefined ? 0 : 1;
      return aEnded === bEnded ? b.id - a.id : aEnded - bEnded;
    })
    .at(0) ?? null;

export type LookupOptions = RegistryClientOptions & {
  /**
   * `historical` includes every superseded record (former statutory body
   * members, shareholders, activities, capital). Name and seat history is
   * included in both views.
   * @default "current"
   */
  view?: RpoView;
};

/**
 * Look up a Slovak legal person, entrepreneur, or public body by IČO: search
 * the register for the number, then fetch the matching record.
 *
 * @returns The entity, or `null` when no record carries the IČO.
 * @throws {RpoValidationError} when the input is not eight digits
 * @throws {RpoAPIError} on upstream HTTP errors or a non-JSON body
 * @throws {RpoRequestError} on network failures and timeouts
 */
export const lookupByIco = async (
  input: string,
  options?: LookupOptions,
): Promise<RpoEntity | null> => {
  const ico = normalizeIco(input);
  if (!isIcoShape(ico)) {
    throw new RpoValidationError(`Invalid Slovak IČO: ${input}`);
  }
  const signal = options?.signal;
  const hit = pickRecordForIco(await search({ identifier: ico }, signal), ico);
  if (!hit) {
    return null;
  }

  const current = options?.view !== "historical";
  // The API reads only the literal `true` as true.
  const query = current ? "" : "?showHistoricalData=true";
  const entity = await rpoGet(
    `${ENTITY_URL}/${encodeURIComponent(String(hit.id))}${query}`,
    isRpoEntity,
    signal,
  );
  if (!entity) {
    return null;
  }

  // The current view drops closed records, and a terminated entity has only
  // closed names and seats. The search row always carries the full name and
  // seat history, so it supplies both in that view.
  const parsed = parseUpstream(() =>
    parseEntity(
      current
        ? {
            ...entity,
            fullNames: hit.fullNames ?? entity.fullNames ?? [],
            addresses: hit.addresses ?? entity.addresses ?? [],
          }
        : entity,
    ),
  );
  return parsed?.ico === ico ? parsed : null;
};

export type SearchOptions = RegistryClientOptions & {
  /** Maximum number of results. Clamped to the adapter ceiling (100). @default 50 */
  limit?: number;
};

const foldForMatch = (value: string): string =>
  value.normalize("NFD").replaceAll(/\p{M}/gu, "").toLocaleLowerCase("sk");

const nameRank = (name: string, query: string): number => {
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  return name.includes(query) ? 2 : 3;
};

/**
 * Search the register by name. Covers every Slovak legal person and
 * entrepreneur, including sole traders, associations, foundations, and
 * public bodies.
 *
 * The register's full-text search returns every row sharing a fragment with
 * the query, in record order, so rows whose name contains the query as a
 * whole rank first, then entities still in existence.
 *
 * @throws {RpoValidationError} if `name` is empty after trimming
 * @throws {RpoAPIError} on upstream HTTP errors or a non-JSON body
 * @throws {RpoRequestError} on network failures and timeouts
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<RpoSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new RpoValidationError("Search name must not be empty");
  }
  const limit = clampSearchLimit(
    options?.limit ?? DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const query = foldForMatch(trimmed);
  const rank = (result: RpoSearchResult): number =>
    nameRank(foldForMatch(result.name), query) * 2 +
    (result.status.type === "active" ? 0 : 1);
  const hits = await search({ fullName: trimmed }, options?.signal);
  return parseUpstream(() => hits.map(parseSearchHit))
    .filter((result) => result !== null)
    .map((result, index) => ({ result, index, rank: rank(result) }))
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map(({ result }) => result);
};
