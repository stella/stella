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

/** Every failure the client reports. */
export type RpoClientError = RpoAPIError | RpoRequestError | RpoValidationError;

type RpoUpstreamError = RpoAPIError | RpoRequestError;

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
const unexpectedPayload = (cause: unknown): RpoAPIError =>
  new RpoAPIError({
    message: "RPO 200: unexpected JSON payload shape",
    httpStatus: 200,
    cause,
  });

// The shared request and body helpers reject with the adapter errors built
// below; anything else is a transport failure or the caller's cancellation.
const requestFailure = (
  url: string,
  cause: unknown,
  signal: AbortSignal | undefined,
): RpoUpstreamError => {
  if (signal?.aborted) {
    return new RpoRequestError(url, "RPO request cancelled", {
      cause: signal.reason,
    });
  }
  return cause instanceof RpoAPIError || cause instanceof RpoRequestError
    ? cause
    : new RpoRequestError(url, "RPO request failed", { cause });
};

const readErrorMessage = async (response: Response): Promise<string | null> => {
  const body = await Result.tryPromise({
    try: async (): Promise<unknown> => await response.json(),
    catch: (cause) => cause,
  });
  // Outage pages and proxies answer with HTML; the status is the signal.
  return body.isOk() &&
    isRecord(body.value) &&
    typeof body.value["message"] === "string"
    ? body.value["message"]
    : null;
};

/** GET a JSON resource. Resolves to `null` on 404 (no such record). */
const rpoGet = async <T>(
  url: string,
  isExpectedShape: (value: unknown) => value is T,
  signal: AbortSignal | undefined,
): Promise<Result<T | null, RpoUpstreamError>> => {
  const response = await Result.tryPromise({
    try: async () =>
      await performRegistryRequest({
        url,
        init: { headers: { Accept: "application/json" } },
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        wrapRequestError: (cause) =>
          new RpoRequestError(url, "RPO request failed", { cause }),
      }),
    catch: (cause) => requestFailure(url, cause, signal),
  });
  if (response.isErr()) {
    return Result.err(response.error);
  }
  const { ok, status, statusText } = response.value;

  if (status === 404) {
    return Result.ok(null);
  }
  if (!ok) {
    const upstreamMessage = await readErrorMessage(response.value);
    if (signal?.aborted) {
      return Result.err(requestFailure(url, null, signal));
    }
    return Result.err(
      new RpoAPIError({
        message: `RPO ${status}: ${upstreamMessage ?? statusText}`,
        httpStatus: status,
        upstreamMessage,
      }),
    );
  }

  // An outage page served with HTTP 200 is HTML and fails here as an invalid
  // JSON payload.
  return await Result.tryPromise({
    try: async (): Promise<T | null> =>
      await readRegistryJson({
        response: response.value,
        signal,
        isExpectedShape,
        wrapParseError: (cause) =>
          new RpoAPIError({
            message: `RPO ${status}: invalid JSON payload`,
            httpStatus: status,
            cause,
          }),
        wrapShapeError: () =>
          new RpoAPIError({
            message: `RPO ${status}: unexpected JSON payload shape`,
            httpStatus: status,
          }),
      }),
    catch: (cause) => requestFailure(url, cause, signal),
  });
};

const search = async (
  params: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Result<RpoRawSearchHit[], RpoUpstreamError>> => {
  const url = `${SEARCH_URL}?${new URLSearchParams(params).toString()}`;
  const response = await rpoGet(url, isRpoSearchResponse, signal);
  if (response.isErr()) {
    return Result.err(response.error);
  }
  if (response.value === null) {
    return Result.err(
      new RpoAPIError({
        message: "RPO 404: no search endpoint",
        httpStatus: 404,
      }),
    );
  }
  return Result.ok(response.value.results);
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
 * Resolves to the entity, or `null` when no record carries the IČO. Fails
 * with `RpoValidationError` when the input is not eight digits, `RpoAPIError`
 * on upstream HTTP errors or an unexpected body, and `RpoRequestError` on
 * network failures, timeouts, and cancellation.
 */
export const lookupByIco = async (
  input: string,
  options?: LookupOptions,
): Promise<Result<RpoEntity | null, RpoClientError>> => {
  const ico = normalizeIco(input);
  if (!isIcoShape(ico)) {
    return Result.err(new RpoValidationError(`Invalid Slovak IČO: ${input}`));
  }
  const signal = options?.signal;
  const hits = await search({ identifier: ico }, signal);
  if (hits.isErr()) {
    return Result.err(hits.error);
  }
  const hit = pickRecordForIco(hits.value, ico);
  if (!hit) {
    return Result.ok(null);
  }

  const current = options?.view !== "historical";
  // The API reads only the literal `true` as true.
  const query = current ? "" : "?showHistoricalData=true";
  const entity = await rpoGet(
    `${ENTITY_URL}/${encodeURIComponent(String(hit.id))}${query}`,
    isRpoEntity,
    signal,
  );
  if (entity.isErr()) {
    return Result.err(entity.error);
  }
  const record = entity.value;
  if (!record) {
    return Result.ok(null);
  }

  // The current view drops closed records, and a terminated entity has only
  // closed names and seats. The search row always carries the full name and
  // seat history, so it supplies both in that view.
  const parsed = Result.try({
    try: () =>
      parseEntity(
        current
          ? {
              ...record,
              fullNames: hit.fullNames ?? record.fullNames ?? [],
              addresses: hit.addresses ?? record.addresses ?? [],
            }
          : record,
      ),
    catch: unexpectedPayload,
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return Result.ok(parsed.value?.ico === ico ? parsed.value : null);
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
 * Fails with `RpoValidationError` if `name` is empty after trimming,
 * `RpoAPIError` on upstream HTTP errors or an unexpected body, and
 * `RpoRequestError` on network failures, timeouts, and cancellation.
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<Result<RpoSearchResult[], RpoClientError>> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return Result.err(new RpoValidationError("Search name must not be empty"));
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
  if (hits.isErr()) {
    return Result.err(hits.error);
  }
  const parsed = Result.try({
    try: () => hits.value.map(parseSearchHit),
    catch: unexpectedPayload,
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return Result.ok(
    parsed.value
      .filter((result) => result !== null)
      .map((result, index) => ({ result, index, rank: rank(result) }))
      .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, limit)
      .map(({ result }) => result),
  );
};
