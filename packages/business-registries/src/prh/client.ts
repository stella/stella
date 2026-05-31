import { PrhAPIError, PrhRequestError, PrhValidationError } from "./errors.js";
import { parseCompany, parseSearchEntry } from "./parse.js";
import type {
  PrhCompaniesResponse,
  PrhCompany,
  PrhErrorResponse,
  PrhSearchResult,
} from "./types.js";
import { normalizeBusinessId, validateBusinessId } from "./validation.js";

const BASE = "https://avoindata.prh.fi/opendata-ytj-api/v3";
const COMPANIES_URL = `${BASE}/companies`;

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;
// PRH paginates at 100 hits per page; mirror Brreg's clamp so the
// dispatch layer can pass through any limit safely.
const MAX_SEARCH_LIMIT = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseErrorBody = (value: unknown): PrhErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: PrhErrorResponse = {};
  if (typeof value["timestamp"] === "string") {
    result.timestamp = value["timestamp"];
  }
  if (typeof value["message"] === "string") {
    result.message = value["message"];
  }
  if (typeof value["errorcode"] === "number") {
    result.errorcode = value["errorcode"];
  }
  return result;
};

const prhGet = async <T>(url: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new PrhRequestError(url, "PRH request failed", { cause: error });
  }

  if (!response.ok) {
    let body: PrhErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON body
    }
    throw new PrhAPIError({
      message: `PRH ${response.status}: ${body.message ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage: body.message ?? null,
      upstreamCode: body.errorcode ?? null,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new PrhRequestError(url, "Failed to parse PRH response JSON", {
      cause: error,
    });
  }

  // SAFETY: PRH AvoinData v3 is a stable, documented public API and
  // the shape is captured by `PrhCompaniesResponse`. Runtime
  // validation adds little for well-typed JSON responses.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return body as T;
};

/**
 * Look up a Finnish entity by Y-tunnus (business ID).
 *
 * PRH does not return 404 for missing IDs; an unknown businessId
 * resolves to `{ totalResults: 0, companies: [] }`. This function
 * collapses that case into `null`.
 *
 * @returns The entity, or `null` if the business ID is not on file.
 * @throws {PrhValidationError} when the businessId fails MOD-11
 * @throws {PrhAPIError} on PRH API errors
 * @throws {PrhRequestError} on network failures
 */
export const lookupByBusinessId = async (
  businessId: string,
): Promise<PrhCompany | null> => {
  const normalized = normalizeBusinessId(businessId);
  if (!validateBusinessId(normalized)) {
    throw new PrhValidationError(`Invalid Y-tunnus: ${businessId}`);
  }
  const params = new URLSearchParams({ businessId: normalized });
  const data = await prhGet<PrhCompaniesResponse>(
    `${COMPANIES_URL}?${params.toString()}`,
  );
  const hit = data.companies.at(0);
  return hit ? parseCompany(hit) : null;
};

export type SearchOptions = {
  /** Maximum number of results. PRH caps each page at 100. @default 50 */
  limit?: number;
};

/**
 * Search PRH `/companies` by name. PRH performs a permissive
 * substring search server-side; results are paginated and clamped to
 * the requested `limit`.
 *
 * @returns A list of matching entities (may be empty).
 * @throws {PrhValidationError} if `name` is empty after trimming
 * @throws {PrhAPIError} on PRH API errors
 * @throws {PrhRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<PrhSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new PrhValidationError("Search name must not be empty");
  }
  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);
  const params = new URLSearchParams({
    name: trimmed,
    maxResults: limit.toString(),
  });
  const data = await prhGet<PrhCompaniesResponse>(
    `${COMPANIES_URL}?${params.toString()}`,
  );
  // Slice defensively in case PRH returns more than the requested
  // maxResults; callers should still get exactly the clamped limit.
  return data.companies.slice(0, limit).map(parseSearchEntry);
};
