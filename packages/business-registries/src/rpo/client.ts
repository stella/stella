import { RpoAPIError, RpoRequestError, RpoValidationError } from "./errors.js";
import { parseCompany, parseSearchEntry } from "./parse.js";
import type {
  RpoCompany,
  RpoErrorResponse,
  RpoRawEntity,
  RpoSearchResponse,
  RpoSearchResult,
} from "./types.js";
import { normalizeIco, validateIco } from "./validation.js";

const BASE = "https://api.statistics.sk/rpo/v1";
const SEARCH_URL = `${BASE}/search`;
const ENTITY_URL = `${BASE}/entity`;

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;
// RPO does not document a hard page size cap, but in practice the
// `/search` endpoint always returns the full match set in one
// response (no `page`/`size` query parameters are honoured). We clamp
// at 100 to match Brreg/PRH and to keep payloads predictable on chat
// turn boundaries.
const MAX_SEARCH_LIMIT = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseErrorBody = (value: unknown): RpoErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: RpoErrorResponse = {};
  if (typeof value["code"] === "number") {
    result.code = value["code"];
  }
  if (typeof value["message"] === "string") {
    result.message = value["message"];
  }
  return result;
};

const rpoGet = async <T>(url: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new RpoRequestError(url, "RPO request failed", { cause: error });
  }

  if (!response.ok) {
    let body: RpoErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON body
    }
    throw new RpoAPIError({
      message: `RPO ${response.status}: ${body.message ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage: body.message ?? null,
      upstreamCode: body.code ?? null,
    });
  }

  // SAFETY: RPO v1 is a stable, documented public API and the shape
  // is captured by `RpoSearchResponse` / `RpoRawEntity`. Runtime
  // validation adds little for well-typed JSON responses.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return response.json() as Promise<T>;
};

/**
 * Look up a Slovak entity by IČO (Identifikačné číslo organizácie).
 *
 * RPO does not provide a direct `/entity?identifier=...` route. The
 * canonical lookup flow is a two-step fetch:
 *   1. `/v1/search?identifier=<ICO>` resolves the IČO to the internal
 *      numeric `id` (always at most one match per IČO).
 *   2. `/v1/entity/{id}` returns the full record (legal form, trade
 *      activities, statutory bodies, …) — the search payload is a
 *      thin row that omits those fields.
 *
 * Both steps are required for the enriched `RpoCompany` shape; an
 * unknown IČO short-circuits after step 1 with `null`.
 *
 * @returns The entity, or `null` if the IČO is not on the register.
 * @throws {RpoValidationError} when the IČO fails MOD-11 validation
 * @throws {RpoAPIError} on RPO API errors
 * @throws {RpoRequestError} on network failures
 */
export const lookupByIco = async (ico: string): Promise<RpoCompany | null> => {
  const normalized = normalizeIco(ico);
  if (!validateIco(normalized)) {
    throw new RpoValidationError(`Invalid IČO: ${ico}`);
  }
  const searchParams = new URLSearchParams({ identifier: normalized });
  const searchData = await rpoGet<RpoSearchResponse>(
    `${SEARCH_URL}?${searchParams.toString()}`,
  );
  const stub = searchData.results.at(0);
  if (!stub) {
    return null;
  }
  // The thin search row carries enough fields to render a reasonable
  // hit (identifiers, fullNames, addresses, sourceRegister), but it
  // omits legalForms, activities, statutoryBodies, statisticalCodes.
  // Fetch the detail payload to get the enriched shape callers expect
  // for an ID-driven lookup.
  const detail = await rpoGet<RpoRawEntity>(`${ENTITY_URL}/${stub.id}`);
  return parseCompany(detail);
};

export type SearchOptions = {
  /**
   * Maximum number of results. RPO returns the full match set in one
   * response; the slice is applied client-side.
   * @default 50
   */
  limit?: number;
  /**
   * Restrict to entities that are currently registered (no termination
   * date). Mirrors the upstream `onlyActive=true` query parameter.
   * @default true
   */
  onlyActive?: boolean;
};

/**
 * Search RPO `/search` by company / entity name (substring, server-side).
 *
 * @returns A list of matching entities (may be empty).
 * @throws {RpoValidationError} if `name` is empty after trimming
 * @throws {RpoAPIError} on RPO API errors
 * @throws {RpoRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<RpoSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new RpoValidationError("Search name must not be empty");
  }
  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);
  const params = new URLSearchParams({
    fullName: trimmed,
    onlyActive: String(options?.onlyActive ?? true),
  });
  const data = await rpoGet<RpoSearchResponse>(
    `${SEARCH_URL}?${params.toString()}`,
  );
  return data.results.slice(0, limit).map(parseSearchEntry);
};
