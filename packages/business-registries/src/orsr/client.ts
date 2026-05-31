import {
  OrsrAPIError,
  OrsrRequestError,
  OrsrValidationError,
} from "./errors.js";
import { parseExtract, parseSearchHit } from "./parse.js";
import type {
  OrsrCompany,
  OrsrRawErrorResponse,
  OrsrRawExtractResponse,
  OrsrRawSearchHit,
  OrsrRawSearchResponse,
  OrsrSearchResult,
} from "./types.js";
import { normalizeIco, validateIco } from "./validation.js";

const BASE = "https://sluzby.orsr.sk/api/legal-person";
const SEARCH_URL = BASE;
const EXTRACT_URL = `${BASE}/extract`;

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;

// The search endpoint accepts a `Take` parameter but does not document
// a hard upper bound. Treat 100 as the safe ceiling so a runaway caller
// cannot ask for thousands of rows on the chat path.
const MAX_SEARCH_LIMIT = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const orsrGet = async <T>(url: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new OrsrRequestError(url, "ORSR request failed", { cause: error });
  }

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

  try {
    // SAFETY: `sluzby.orsr.sk` is a stable, documented Ministry of
    // Justice surface backed by a published XSD. Runtime validation
    // adds little for well-typed JSON; the parser tolerates absent
    // fields so upstream drift surfaces as `null` rather than a throw.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return (await response.json()) as T;
  } catch (error) {
    throw new OrsrAPIError({
      message: `ORSR ${response.status}: invalid JSON payload`,
      httpStatus: response.status,
      upstreamMessage: null,
      cause: error,
    });
  }
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

const pickLatestHit = (
  hits: OrsrRawSearchHit[] | undefined,
): OrsrRawSearchHit | null => {
  if (!hits || hits.length === 0) {
    return null;
  }
  // Re-registrations preserve the IČO but mint a fresh internal `id`;
  // the highest internal id is the live record (or, for terminated
  // entities, the final registry state). Sort descending so the
  // primary lookup path always sees the most recent entry.
  const sorted = [...hits].sort((a, b) => b.id - a.id);
  return sorted.at(0) ?? null;
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
 * @returns The entity, or `null` if the IČO is not on file.
 * @throws {OrsrValidationError} when the IČO fails MOD-11
 * @throws {OrsrAPIError} on upstream HTTP errors
 * @throws {OrsrRequestError} on network failures
 */
export const lookupByIco = async (ico: string): Promise<OrsrCompany | null> => {
  const normalized = normalizeIco(ico);
  if (!validateIco(normalized)) {
    throw new OrsrValidationError(`Invalid Slovak IČO: ${ico}`);
  }

  const searchData = await orsrGet<OrsrRawSearchResponse>(
    buildSearchUrl(normalized),
  );
  const hit = pickLatestHit(searchData.data);
  if (!hit) {
    return null;
  }

  const fileRef = hit.fileReference;
  if (
    !fileRef?.section ||
    fileRef.insertNumber === undefined ||
    !fileRef.court
  ) {
    return null;
  }

  const extractParams = new URLSearchParams({
    oddiel: fileRef.section,
    vlozka: String(fileRef.insertNumber),
    sud: fileRef.court,
  });
  const extract = await orsrGet<OrsrRawExtractResponse>(
    `${EXTRACT_URL}?${extractParams.toString()}`,
  );
  return parseExtract(extract);
};

export type SearchOptions = {
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
 * @throws {OrsrAPIError} on upstream HTTP errors
 * @throws {OrsrRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<OrsrSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new OrsrValidationError("Search name must not be empty");
  }
  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const take = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);
  const searchTake = Math.min(
    Math.max(take, DEFAULT_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT,
  );
  const data = await orsrGet<OrsrRawSearchResponse>(
    buildSearchUrl(trimmed, searchTake),
  );
  return dedupeLatestHitsByIco(data.data).slice(0, take).map(parseSearchHit);
};
