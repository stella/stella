import {
  BrregAPIError,
  BrregRequestError,
  BrregTooBroadError,
  BrregValidationError,
} from "./errors.js";
import { parseEnhet, parseSearchEntry } from "./parse.js";
import type {
  BrregEntity,
  BrregErrorResponse,
  BrregRawEnhet,
  BrregSearchResponse,
  BrregSearchResult,
} from "./types.js";
import { normalizeOrgnr, validateOrgnr } from "./validation.js";

const BASE = "https://data.brreg.no/enhetsregisteret/api";
const ENHETER_URL = `${BASE}/enheter`;
const UNDERENHETER_URL = `${BASE}/underenheter`;

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const BRREG_RESULT_CAP = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseErrorBody = (value: unknown): BrregErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: BrregErrorResponse = {};
  if (typeof value["status"] === "number") {
    result.status = value["status"];
  }
  if (typeof value["feilmelding"] === "string") {
    result.feilmelding = value["feilmelding"];
  }
  if (typeof value["hjelp"] === "string") {
    result.hjelp = value["hjelp"];
  }
  return result;
};

const brregGet = async <T>(url: string): Promise<T | null> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new BrregRequestError(url, "Brreg request failed", { cause: error });
  }

  if (response.status === 404) {
    return null;
  }

  // 410 Gone — Brreg uses this for entities removed from disclosure
  // (typically by court order or another legal requirement). The
  // response body carries an error envelope, not an entity payload,
  // so we surface "no result" rather than feeding the body through
  // the entity parser.
  //
  // Struck-off / deleted entities — which still belong in the domain
  // model — come back as `200 OK` with `slettedato` set; the parser
  // handles those via BrregEntityStatus's "deleted" arm.
  if (response.status === 410) {
    return null;
  }

  if (!response.ok) {
    let body: BrregErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON error body
    }
    throw new BrregAPIError({
      message: `Brreg ${response.status}: ${body.feilmelding ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage: body.feilmelding ?? null,
    });
  }

  // SAFETY: Brreg is a stable, documented public API. Runtime validation
  // adds little for well-typed JSON responses.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return response.json() as Promise<T>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LookupOptions = {
  /**
   * Whether to fall back to the sub-entity (underenheter) register when the
   * main `enheter` register returns 404. Useful when the orgnr identifies a
   * branch rather than a parent company.
   * @default true
   */
  includeSubEntities?: boolean;
};

/**
 * Look up a Norwegian entity by organisasjonsnummer.
 *
 * Hits the main `enheter` register first. If the orgnr is not found and
 * `includeSubEntities` is true (default), tries `underenheter`.
 *
 * @returns The entity, or `null` if the orgnr does not exist.
 * @throws {BrregValidationError} if the orgnr fails MOD-11 validation
 * @throws {BrregAPIError} on Brreg API errors
 * @throws {BrregRequestError} on network failures
 */
export const lookupByOrgnr = async (
  orgnr: string,
  options?: LookupOptions,
): Promise<BrregEntity | null> => {
  const normalized = normalizeOrgnr(orgnr);

  if (!validateOrgnr(normalized)) {
    throw new BrregValidationError(`Invalid orgnr: ${orgnr}`);
  }

  const enhet = await brregGet<BrregRawEnhet>(`${ENHETER_URL}/${normalized}`);
  if (enhet) {
    return parseEnhet(enhet);
  }

  if (options?.includeSubEntities ?? true) {
    const sub = await brregGet<BrregRawEnhet>(
      `${UNDERENHETER_URL}/${normalized}`,
    );
    if (sub) {
      return parseEnhet(sub);
    }
  }

  return null;
};

export type SearchOptions = {
  /** Maximum number of results. Brreg caps each page at 100. @default 50 */
  limit?: number;
};

/**
 * Search Brreg `enheter` by company name (case-insensitive substring).
 *
 * @returns A list of matching entities (may be empty).
 * @throws {BrregTooBroadError} if the search would exceed Brreg's 10k cap
 * @throws {BrregAPIError} on Brreg API errors
 * @throws {BrregRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<BrregSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new BrregValidationError("Search name must not be empty");
  }
  if (trimmed.length > 180) {
    throw new BrregValidationError(
      "Search name must be 180 characters or fewer",
    );
  }

  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const size = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);

  const params = new URLSearchParams({
    navn: trimmed,
    size: String(size),
  });
  const url = `${ENHETER_URL}?${params.toString()}`;

  const data = await brregGet<BrregSearchResponse>(url);
  if (!data) {
    return [];
  }

  const total = data.page?.totalElements ?? 0;
  if (total > BRREG_RESULT_CAP) {
    throw new BrregTooBroadError(trimmed);
  }

  const entries = data._embedded?.enheter ?? [];
  return entries.map(parseSearchEntry);
};
