import {
  CompaniesHouseAPIError,
  CompaniesHouseAuthError,
  CompaniesHouseRequestError,
  CompaniesHouseValidationError,
} from "./errors.js";
import {
  parseCompanyProfile,
  parseOfficersResponse,
  parseSearchResponse,
} from "./parse.js";
import type {
  CompaniesHouseCompany,
  CompaniesHouseOfficer,
  CompaniesHouseRawCompanyProfile,
  CompaniesHouseRawOfficersResponse,
  CompaniesHouseRawSearchResponse,
  CompaniesHouseSearchResult,
} from "./types.js";
import { normalizeCompanyNumber, validateCompanyNumber } from "./validation.js";

const COMPANIES_HOUSE_BASE = "https://api.company-information.service.gov.uk";
const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 20;
// Companies House caps each /search/companies page at 100; requesting
// more returns 400. Clamp to keep the adapter useful even when callers
// pass an over-eager limit.
const MAX_SEARCH_LIMIT = 100;

// The API key is mandatory. Companies House authenticates every
// request via HTTP Basic with the key as the username and an empty
// password; missing or wrong credentials return 401. We surface a
// distinct `CompaniesHouseAuthError` so dispatch can translate it
// into a clear "API key not configured" 502 instead of a 401 that the
// end user cannot fix.
export type CompaniesHouseClientConfig = {
  /**
   * Companies House API key. Free, instant via
   * https://developer.company-information.service.gov.uk. Sent as the
   * HTTP Basic username with an empty password.
   */
  apiKey: string;
};

const assertApiKey = (apiKey: string): void => {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new CompaniesHouseAuthError(
      "Companies House requires an API key. Get one at https://developer.company-information.service.gov.uk and set COMPANIES_HOUSE_API_KEY.",
    );
  }
};

const buildAuthHeader = (apiKey: string): string => {
  // HTTP Basic: base64("<key>:"). Use the Web standard `btoa` so the
  // package stays edge-runtime portable (Cloudflare Workers, Deno)
  // — Companies House keys are ASCII, so the legacy-encoding caveat
  // does not apply.
  const token = btoa(`${apiKey}:`);
  return `Basic ${token}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readUpstreamMessage = async (
  response: Response,
): Promise<string | null> => {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await response.text();
      return body.length > 0 ? body.slice(0, 200) : null;
    } catch {
      return null;
    }
  }
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      return null;
    }
    // Companies House error envelope: { errors: [{ error, type }], ... }.
    // Surface the first `error` string if present, else fall back to
    // top-level `error`/`message`.
    const errors: unknown = body["errors"];
    if (Array.isArray(errors)) {
      const first: unknown = errors.at(0);
      if (isRecord(first) && typeof first["error"] === "string") {
        return first["error"];
      }
    }
    if (typeof body["error"] === "string") {
      return body["error"];
    }
    if (typeof body["message"] === "string") {
      return body["message"];
    }
    return null;
  } catch {
    return null;
  }
};

const companiesHouseGet = async <T>(
  url: string,
  apiKey: string,
): Promise<T | null> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: buildAuthHeader(apiKey),
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new CompaniesHouseRequestError(
      url,
      "Companies House request failed",
      { cause: error },
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    const upstreamMessage = await readUpstreamMessage(response);
    throw new CompaniesHouseAuthError(
      `Companies House rejected the API key (${response.status}). Verify COMPANIES_HOUSE_API_KEY is set to a live key from https://developer.company-information.service.gov.uk.${
        upstreamMessage ? ` Upstream: ${upstreamMessage}` : ""
      }`,
    );
  }

  if (!response.ok) {
    const upstreamMessage = await readUpstreamMessage(response);
    throw new CompaniesHouseAPIError({
      message: `Companies House ${response.status}: ${upstreamMessage ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new CompaniesHouseAPIError({
      message: "Companies House returned a non-JSON response",
      httpStatus: response.status,
      cause: error,
    });
  }
  if (!isRecord(json)) {
    throw new CompaniesHouseAPIError({
      message: "Companies House returned an unexpected response shape",
      httpStatus: response.status,
    });
  }
  // SAFETY: Companies House publishes a stable, documented JSON shape
  // for every endpoint we call. The parser tolerates absent optional
  // fields, so we narrow structurally at the top (`isRecord`) and let
  // the parser handle the rest.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return json as T;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a UK company by its Companies House registration number.
 *
 * @returns The company profile, or `null` if the number is unknown.
 * @throws {CompaniesHouseValidationError} if the number fails shape
 *   validation.
 * @throws {CompaniesHouseAuthError} if the API key is missing or
 *   rejected (401 / 403).
 * @throws {CompaniesHouseAPIError} on other Companies House API
 *   errors.
 * @throws {CompaniesHouseRequestError} on network failures.
 */
export const lookupByCompanyNumber = async (
  input: string,
  config: CompaniesHouseClientConfig,
): Promise<CompaniesHouseCompany | null> => {
  assertApiKey(config.apiKey);
  const normalized = normalizeCompanyNumber(input);
  if (!validateCompanyNumber(normalized)) {
    throw new CompaniesHouseValidationError(
      `Invalid UK company number: ${input}`,
    );
  }
  const url = `${COMPANIES_HOUSE_BASE}/company/${encodeURIComponent(normalized)}`;
  const raw = await companiesHouseGet<CompaniesHouseRawCompanyProfile>(
    url,
    config.apiKey,
  );
  if (!raw) {
    return null;
  }
  return parseCompanyProfile(raw);
};

export type SearchOptions = {
  /**
   * Maximum number of results to return. Companies House clamps each
   * `/search/companies` page at 100; values above are silently
   * clamped.
   * @default 20
   */
  limit?: number;
  /** Zero-based offset into the result set. @default 0 */
  startIndex?: number;
};

/**
 * Search UK companies by name fragment.
 *
 * @returns A list of matching companies (may be empty). Includes
 *   dissolved entities — filter on `status.type` if the caller only
 *   wants active companies.
 * @throws {CompaniesHouseValidationError} on empty input.
 * @throws {CompaniesHouseAuthError} on bad credentials.
 * @throws {CompaniesHouseAPIError} on other API errors.
 * @throws {CompaniesHouseRequestError} on network failures.
 */
export const searchByName = async (
  query: string,
  config: CompaniesHouseClientConfig,
  options?: SearchOptions,
): Promise<CompaniesHouseSearchResult[]> => {
  assertApiKey(config.apiKey);
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new CompaniesHouseValidationError("Search query must not be empty");
  }
  const requested = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const itemsPerPage = Math.min(Math.max(requested, 1), MAX_SEARCH_LIMIT);
  const startIndex = Math.max(options?.startIndex ?? 0, 0);

  const params = new URLSearchParams({
    q: trimmed,
    items_per_page: String(itemsPerPage),
    start_index: String(startIndex),
  });
  const url = `${COMPANIES_HOUSE_BASE}/search/companies?${params.toString()}`;
  const raw = await companiesHouseGet<CompaniesHouseRawSearchResponse>(
    url,
    config.apiKey,
  );
  if (!raw) {
    return [];
  }
  return parseSearchResponse(raw);
};

/**
 * Look up the officer roster for a UK company.
 *
 * Returns active and resigned officers in a single list; flag via
 * `isResigned` so callers can render "former director" etc. instead
 * of dropping records.
 *
 * @returns The officer list, or `[]` if the company number is unknown.
 * @throws {CompaniesHouseValidationError} if the number fails shape
 *   validation.
 * @throws {CompaniesHouseAuthError} on bad credentials.
 * @throws {CompaniesHouseAPIError} on other API errors.
 * @throws {CompaniesHouseRequestError} on network failures.
 */
// Companies House paginates the officer list. The default page size
// is 35 and the maximum is 100; large boards (FTSE 100, insolvent
// estates with many liquidators) routinely exceed either.
const OFFICERS_PAGE_SIZE = 100;
// Defensive hard ceiling — covers up to 100k officers, well beyond
// any company on record. Exists only to guarantee termination if
// upstream returns a malformed `total_results` that keeps the loop
// "almost done" forever; the loop normally exits on
// `fetched >= total_results` long before this.
const OFFICERS_MAX_PAGES = 1000;

export type OfficersOptions = {
  /**
   * Maximum number of officers to return across all pages. Unbounded
   * by default — the function pages through `total_results`. Callers
   * that only need a top-N can request fewer to skip later pages
   * entirely.
   */
  limit?: number;
};

export const lookupOfficersByCompanyNumber = async (
  input: string,
  config: CompaniesHouseClientConfig,
  options?: OfficersOptions,
): Promise<CompaniesHouseOfficer[]> => {
  assertApiKey(config.apiKey);
  const normalized = normalizeCompanyNumber(input);
  if (!validateCompanyNumber(normalized)) {
    throw new CompaniesHouseValidationError(
      `Invalid UK company number: ${input}`,
    );
  }
  const limit =
    options?.limit !== undefined
      ? Math.max(options.limit, 1)
      : Number.POSITIVE_INFINITY;
  const collected: CompaniesHouseOfficer[] = [];
  for (let page = 0; page < OFFICERS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      items_per_page: String(OFFICERS_PAGE_SIZE),
      start_index: String(page * OFFICERS_PAGE_SIZE),
    });
    const url = `${COMPANIES_HOUSE_BASE}/company/${encodeURIComponent(normalized)}/officers?${params.toString()}`;
    const raw = await companiesHouseGet<CompaniesHouseRawOfficersResponse>(
      url,
      config.apiKey,
    );
    if (!raw) {
      return collected;
    }
    const parsed = parseOfficersResponse(raw);
    collected.push(...parsed);
    if (collected.length >= limit) {
      return collected.slice(0, limit);
    }
    const fetched = (page + 1) * OFFICERS_PAGE_SIZE;
    const totalResults = raw.total_results ?? collected.length;
    if (fetched >= totalResults || parsed.length === 0) {
      return collected;
    }
  }
  return Number.isFinite(limit) ? collected.slice(0, limit) : collected;
};
