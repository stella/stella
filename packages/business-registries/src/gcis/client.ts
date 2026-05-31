import {
  GcisAPIError,
  GcisRequestError,
  GcisValidationError,
} from "./errors.js";
import { parseCompany, parseSearchEntry } from "./parse.js";
import type { GcisCompany, GcisResponse, GcisSearchResult } from "./types.js";
import { normalizeTaxId, validateTaxId } from "./validation.js";

const GCIS_API_BASE = "https://data.gcis.nat.gov.tw/od/data/api";
// Lookup-by-tongbian dataset (richer payload: capital, responsible
// person, suspension lifecycle, registering authority).
const LOOKUP_DATASET = "5F64D864-61CB-4D0D-8AD9-492047CC1EA6";
// Name-search dataset. Ships the same baseline fields as the lookup
// dataset plus the explicit `Company_Status` numeric code.
const SEARCH_DATASET = "6BBA2268-1367-4B42-9CCA-BC17499EBE8C";

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;
// GCIS has no documented hard cap on `$top`, but the upstream payload
// is unsorted and returning hundreds of TWD-locale rows costs the
// model more than it returns. Mirror the brreg/prh ceiling so the
// dispatch layer can pass any limit through safely.
const MAX_SEARCH_LIMIT = 100;
// GCIS filter status codes for active registrations. `01` is 核准設立
// and `02` is 核准登記 (common for foreign branches); both map to the
// active domain status in parse.ts.
const ACTIVE_STATUS_FILTER =
  "(Company_Status eq '01' or Company_Status eq '02')";

const odataStringLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const buildUrl = (
  datasetId: string,
  params: Record<string, string>,
): string => {
  // GCIS uses OData-style `$`-prefixed parameters
  // (`$format`, `$filter`, `$skip`, `$top`). URLSearchParams encodes
  // the leading `$` correctly; no manual escaping needed.
  const search = new URLSearchParams(params);
  return `${GCIS_API_BASE}/${datasetId}?${search.toString()}`;
};

const gcisGet = async (url: string): Promise<GcisResponse> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new GcisRequestError(url, "GCIS request failed", { cause: error });
  }

  if (!response.ok) {
    let upstreamText: string | null = null;
    try {
      upstreamText = (await response.text()).trim() || null;
    } catch {
      // upstream body unreadable
    }
    throw new GcisAPIError({
      message: `GCIS ${response.status}: ${upstreamText ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage: upstreamText,
    });
  }

  // GCIS returns an empty body (Content-Length: 0) for "no match";
  // `response.json()` would throw on that. Read as text first, then
  // collapse empty / whitespace-only bodies into an empty array.
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    throw new GcisRequestError(url, "GCIS response body unreadable", {
      cause: error,
    });
  }
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    return [];
  }
  // GCIS will sometimes serve a Chinese HTML "system busy" page with
  // a 200 status code; guard so we don't crash JSON.parse and so we
  // surface a meaningful upstream error.
  if (!trimmed.startsWith("[")) {
    throw new GcisAPIError({
      message: "GCIS returned a non-JSON body (likely a busy / error page)",
      httpStatus: response.status,
      upstreamMessage: trimmed.slice(0, 200),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new GcisAPIError({
      message: "GCIS returned malformed JSON",
      httpStatus: response.status,
      upstreamMessage: trimmed.slice(0, 200),
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new GcisAPIError({
      message: "GCIS returned a non-array JSON payload",
      httpStatus: response.status,
    });
  }
  // SAFETY: per-row shape is enforced when each entry is parsed into
  // the domain type; treating the array entries as `GcisRawCompany`
  // here just defers full validation to `parseCompany` /
  // `parseSearchEntry`, which read fields defensively.
  return parsed as GcisResponse;
};

/**
 * Look up a Taiwanese entity by 統一編號 (tongbian / 8-digit tax ID).
 *
 * GCIS does not return 404 for missing IDs; an unknown tongbian
 * resolves to an empty array body. This function collapses that case
 * into `null`.
 *
 * @returns The entity, or `null` if the tax ID is not on file.
 * @throws {GcisValidationError} when the tax ID fails the MoF check digit
 * @throws {GcisAPIError} on GCIS API errors
 * @throws {GcisRequestError} on network failures
 */
export const lookupByTaxId = async (
  taxId: string,
): Promise<GcisCompany | null> => {
  const normalized = normalizeTaxId(taxId);
  if (!validateTaxId(normalized)) {
    throw new GcisValidationError(`Invalid 統一編號 (tax ID): ${taxId}`);
  }
  const url = buildUrl(LOOKUP_DATASET, {
    $format: "json",
    $filter: `Business_Accounting_NO eq ${odataStringLiteral(normalized)}`,
    $skip: "0",
    $top: "1",
  });
  const rows = await gcisGet(url);
  const hit = rows.at(0);
  return hit ? parseCompany(hit) : null;
};

export type SearchOptions = {
  /** Maximum number of results. @default 50 */
  limit?: number;
  /**
   * When true (default), restrict the search to currently-active
   * companies (`Company_Status eq '01' or '02'`). Set to `false`
   * to include dissolved / suspended entries; the GCIS dataset is
   * large and mostly returns active hits anyway, so the default trims
   * the payload without losing relevant matches.
   */
  activeOnly?: boolean;
};

/**
 * Search GCIS by Chinese company name (substring match via OData
 * `like`).
 *
 * @returns A list of matching entities (may be empty).
 * @throws {GcisValidationError} if `name` is empty after trimming
 * @throws {GcisAPIError} on GCIS API errors
 * @throws {GcisRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<GcisSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new GcisValidationError("Search name must not be empty");
  }
  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const top = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);
  const activeOnly = options?.activeOnly ?? true;
  const quotedName = odataStringLiteral(trimmed);
  const filter = activeOnly
    ? `Company_Name like ${quotedName} and ${ACTIVE_STATUS_FILTER}`
    : `Company_Name like ${quotedName}`;
  const url = buildUrl(SEARCH_DATASET, {
    $format: "json",
    $filter: filter,
    $skip: "0",
    $top: String(top),
  });
  const rows = await gcisGet(url);
  return rows.map((row) => parseSearchEntry(row));
};
