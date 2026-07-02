import {
  DenueAPIError,
  DenueAuthError,
  DenueRequestError,
  DenueValidationError,
} from "./errors.js";
import { parseEstablishment, parseSearchEntry } from "./parse.js";
import type {
  DenueEstablishment,
  DenueRawEstablishment,
  DenueResponse,
  DenueSearchResult,
} from "./types.js";
import {
  normalizeEstablishmentId,
  normalizeStateCode,
  validateEstablishmentId,
  validateStateCode,
} from "./validation.js";

const DENUE_API_BASE = "https://www.inegi.org.mx/app/api/denue/v1/consulta";
const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const ALL_STATES_CODE = "00";

export type DenueClientOptions = {
  /**
   * INEGI DENUE API token. Register at
   * https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx.
   */
  token: string;
  /** Override for tests or mirrors. @default official INEGI endpoint */
  baseUrl?: string;
  /** Request timeout in milliseconds. @default 10000 */
  timeoutMs?: number;
};

export type SearchOptions = {
  /** Maximum number of results. @default 50 */
  limit?: number;
  /**
   * Optional two-digit Mexican state code (01-32). Omit or pass "00"
   * for a national search.
   */
  stateCode?: string;
};

const requireToken = ({ token }: DenueClientOptions): string => {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new DenueAuthError(
      "INEGI DENUE requires an API token. Get one at https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx and set INEGI_DENUE_API_TOKEN.",
    );
  }
  return trimmed;
};

const encodePathSegment = (value: string): string => encodeURIComponent(value);

const buildUrl = (
  options: DenueClientOptions,
  segments: readonly string[],
): string => {
  const base = options.baseUrl ?? DENUE_API_BASE;
  const cleanBase = stripTrailingSlashes(base);
  const encodedPath = segments.map(encodePathSegment).join("/");
  return `${cleanBase}/${encodedPath}`;
};

const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.at(end - 1) === "/") {
    end--;
  }
  return value.slice(0, end);
};

const denueGet = async (
  url: string,
  options: DenueClientOptions,
): Promise<DenueResponse> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new DenueRequestError(
      redactToken(url, options),
      "DENUE request failed",
      { cause: error },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new DenueAuthError(
      "INEGI DENUE rejected the API token. Verify INEGI_DENUE_API_TOKEN is set to a live token.",
    );
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    throw new DenueRequestError(
      redactToken(url, options),
      "DENUE response body unreadable",
      { cause: error },
    );
  }

  if (!response.ok) {
    const upstreamText = bodyText.trim() || null;
    throw new DenueAPIError({
      message: `DENUE ${response.status}: ${upstreamText ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage: upstreamText,
    });
  }

  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new DenueAPIError({
      message: "DENUE returned malformed JSON",
      httpStatus: response.status,
      upstreamMessage: trimmed.slice(0, 200),
      cause: error,
    });
  }

  if (!isDenueResponse(parsed)) {
    throw new DenueAPIError({
      message: "DENUE returned an unexpected JSON payload shape",
      httpStatus: response.status,
    });
  }

  return parsed;
};

const redactToken = (url: string, options: DenueClientOptions): string =>
  url.replace(encodeURIComponent(requireToken(options)), "[redacted]");

const isDenueResponse = (value: unknown): value is DenueResponse => {
  if (!Array.isArray(value)) {
    return false;
  }
  return (
    value.every((entry) => typeof entry === "string") ||
    value.every(hasRawEstablishmentShape)
  );
};

const hasRawEstablishmentShape = (
  value: unknown,
): value is DenueRawEstablishment => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("Id" in value) || !("Nombre" in value)) {
    return false;
  }
  return typeof value.Id === "string" && typeof value.Nombre === "string";
};

const isDenueErrorResponse = (response: DenueResponse): response is string[] =>
  response.every((entry) => typeof entry === "string");

const extractRows = (response: DenueResponse): DenueRawEstablishment[] => {
  if (response.length === 0) {
    return [];
  }
  if (!isDenueErrorResponse(response)) {
    return response;
  }
  const message = response.join(" ").trim();
  if (!message || /no se encontraron resultados/iu.test(message)) {
    return [];
  }
  if (/token|autoriz|credencial|key/iu.test(message)) {
    throw new DenueAuthError(`DENUE token rejected: ${message}`);
  }
  throw new DenueAPIError({
    message: `DENUE returned an error response: ${message}`,
    httpStatus: 200,
    upstreamMessage: message,
  });
};

/**
 * Look up a Mexican economic unit by DENUE establishment Id.
 *
 * @returns The establishment, or `null` when the Id is not on file.
 * @throws {DenueAuthError} when the token is missing or rejected
 * @throws {DenueValidationError} when the Id format is invalid
 * @throws {DenueAPIError} on DENUE API errors
 * @throws {DenueRequestError} on network failures
 */
export const lookupByEstablishmentId = async (
  id: string,
  options: DenueClientOptions,
): Promise<DenueEstablishment | null> => {
  const normalized = normalizeEstablishmentId(id);
  if (!validateEstablishmentId(normalized)) {
    throw new DenueValidationError(`Invalid DENUE establishment Id: ${id}`);
  }
  const token = requireToken(options);
  const url = buildUrl(options, ["Ficha", normalized, token]);
  const rows = extractRows(await denueGet(url, options));
  const hit = rows.at(0);
  return hit ? parseEstablishment(hit) : null;
};

/**
 * Search DENUE by establishment name or legal name.
 *
 * @returns A list of matching economic units (may be empty).
 * @throws {DenueAuthError} when the token is missing or rejected
 * @throws {DenueValidationError} if inputs are empty or invalid
 * @throws {DenueAPIError} on DENUE API errors
 * @throws {DenueRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  clientOptions: DenueClientOptions,
  options?: SearchOptions,
): Promise<DenueSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new DenueValidationError("Search name must not be empty");
  }
  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);
  const stateCode = normalizeStateCode(options?.stateCode ?? ALL_STATES_CODE);
  if (!validateStateCode(stateCode)) {
    throw new DenueValidationError(
      `Invalid Mexican state code for DENUE search: ${options?.stateCode}`,
    );
  }

  const token = requireToken(clientOptions);
  const url = buildUrl(clientOptions, [
    "Nombre",
    trimmed,
    stateCode,
    "1",
    String(limit),
    token,
  ]);
  const rows = extractRows(await denueGet(url, clientOptions));
  return rows.slice(0, limit).map((row) => parseSearchEntry(row));
};
