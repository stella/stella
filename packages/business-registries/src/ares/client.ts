import {
  AresAPIError,
  AresRequestError,
  AresTooBroadError,
  AresValidationError,
} from "./errors.js";
import { enrichWithVr, parseResRecord, parseSearchEntry } from "./parse.js";
import type {
  AresCompany,
  AresErrorResponse,
  AresResResponse,
  AresSearchResponse,
  AresSearchResult,
  AresVrResponse,
} from "./types.js";
import { normalizeIco, validateIco } from "./validation.js";

const BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

const RES_URL = `${BASE}/ekonomicke-subjekty-res`;
const VR_URL = `${BASE}/ekonomicke-subjekty-vr`;
const SEARCH_URL = `${BASE}/ekonomicke-subjekty/vyhledat`;

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalRecord = (value: unknown): boolean =>
  value === undefined || isRecord(value);

const isOptionalStringArray = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const isOptionalRecordArray = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every(isRecord));

const isAresResRecord = (
  value: unknown,
): value is AresResResponse["zaznamy"][number] =>
  isRecord(value) &&
  typeof value["ico"] === "string" &&
  typeof value["obchodniJmeno"] === "string" &&
  typeof value["primarniZaznam"] === "boolean" &&
  isOptionalRecord(value["sidlo"]) &&
  isOptionalStringArray(value["czNace"]);

const isAresResResponse = (value: unknown): value is AresResResponse =>
  isRecord(value) &&
  typeof value["icoId"] === "string" &&
  Array.isArray(value["zaznamy"]) &&
  value["zaznamy"].every(isAresResRecord);

const isAresVrRecord = (
  value: unknown,
): value is AresVrResponse["zaznamy"][number] =>
  isRecord(value) &&
  typeof value["primarniZaznam"] === "boolean" &&
  isOptionalRecordArray(value["obchodniJmeno"]) &&
  isOptionalRecordArray(value["ico"]) &&
  isOptionalRecordArray(value["adresy"]) &&
  (value["pravniForma"] === undefined ||
    typeof value["pravniForma"] === "string" ||
    isOptionalRecordArray(value["pravniForma"])) &&
  isOptionalRecordArray(value["spisovaZnacka"]) &&
  isOptionalRecordArray(value["zakladniKapital"]) &&
  isOptionalRecordArray(value["statutarniOrgany"]) &&
  isOptionalRecordArray(value["ostatniOrgany"]) &&
  isOptionalRecordArray(value["datumVzniku"]);

const isAresVrResponse = (value: unknown): value is AresVrResponse =>
  isRecord(value) &&
  typeof value["icoId"] === "string" &&
  Array.isArray(value["zaznamy"]) &&
  value["zaznamy"].every(isAresVrRecord);

const isAresSearchEntry = (
  value: unknown,
): value is AresSearchResponse["ekonomickeSubjekty"][number] =>
  isRecord(value) &&
  (value["ico"] === undefined || typeof value["ico"] === "string") &&
  typeof value["obchodniJmeno"] === "string" &&
  isOptionalRecord(value["sidlo"]);

const isAresSearchResponse = (value: unknown): value is AresSearchResponse =>
  isRecord(value) &&
  typeof value["pocetCelkem"] === "number" &&
  Array.isArray(value["ekonomickeSubjekty"]) &&
  value["ekonomickeSubjekty"].every(isAresSearchEntry);

const parseErrorBody = (value: unknown): AresErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: AresErrorResponse = {};
  if (typeof value["kod"] === "string") {
    result.kod = value["kod"];
  }
  if (typeof value["subKod"] === "string") {
    result.subKod = value["subKod"];
  }
  if (typeof value["popis"] === "string") {
    result.popis = value["popis"];
  }
  return result;
};

const handleAresError = async (
  response: Response,
  url: string,
): Promise<never> => {
  let body: AresErrorResponse = {};
  try {
    body = parseErrorBody(await response.json());
  } catch {
    // non-JSON error body; leave defaults
  }

  if (
    response.status === 400 &&
    body.subKod === "VYSTUP_PRILIS_MNOHO_VYSLEDKU"
  ) {
    throw new AresTooBroadError(url);
  }

  throw new AresAPIError({
    message: `ARES ${response.status}: ${body.popis ?? response.statusText}`,
    httpStatus: response.status,
    aresCode: body.kod ?? null,
    aresDescription: body.popis ?? null,
  });
};

const readAresJson = async <T>(
  response: Response,
  isExpectedShape: (value: unknown) => value is T,
): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AresAPIError({
      message: "ARES returned a non-JSON response",
      httpStatus: response.status,
      cause: error,
    });
  }

  if (!isExpectedShape(body)) {
    throw new AresAPIError({
      message: "ARES returned an unexpected response shape",
      httpStatus: response.status,
    });
  }

  return body;
};

const aresGet = async <T>(
  url: string,
  isExpectedShape: (value: unknown) => value is T,
): Promise<T | null> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new AresRequestError(url, "ARES request failed", { cause: error });
  }

  if (response.status === 404) {
    let body: AresErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // ignore
    }
    if (body.kod === "NENALEZENO") {
      return null;
    }
    throw new AresAPIError({
      message: `ARES 404: ${body.popis ?? "Not found"}`,
      httpStatus: 404,
      aresCode: body.kod ?? null,
      aresDescription: body.popis ?? null,
    });
  }

  if (!response.ok) {
    await handleAresError(response, url);
  }

  return readAresJson(response, isExpectedShape);
};

const aresPost = async <T>(
  url: string,
  payload: unknown,
  isExpectedShape: (value: unknown) => value is T,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new AresRequestError(url, "ARES request failed", { cause: error });
  }

  if (!response.ok) {
    await handleAresError(response, url);
  }

  return readAresJson(response, isExpectedShape);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LookupOptions = {
  /**
   * Whether to fetch VR (commercial register) data for enrichment.
   * Adds statutory bodies, share capital, court file, acting clause.
   * @default true
   */
  includeVr?: boolean;
};

/**
 * Look up a Czech economic subject by IČO.
 *
 * Fetches from the RES register first (universal). If `includeVr` is true
 * (default), also fetches from the VR register and merges the richer data.
 *
 * @returns The company data, or `null` if the IČO does not exist.
 * @throws {AresValidationError} if the IČO fails checksum validation
 * @throws {AresAPIError} on ARES API errors
 * @throws {AresRequestError} on network failures
 */
export const lookupByIco = async (
  ico: string,
  options?: LookupOptions,
): Promise<AresCompany | null> => {
  const normalized = normalizeIco(ico);

  if (!validateIco(normalized)) {
    throw new AresValidationError(`Invalid IČO: ${ico}`);
  }

  const includeVr = options?.includeVr ?? true;

  // Fetch RES (always) and VR (optionally, in parallel)
  const resPromise = aresGet(`${RES_URL}/${normalized}`, isAresResResponse);
  const vrPromise = includeVr
    ? aresGet(`${VR_URL}/${normalized}`, isAresVrResponse)
    : null;

  const [resData, vrData] = await Promise.all([
    resPromise,
    vrPromise ?? Promise.resolve(null),
  ]);

  if (!resData) {
    return null;
  }

  const primaryRecord = resData.zaznamy.find((z) => z.primarniZaznam);
  if (!primaryRecord) {
    return null;
  }

  let company = parseResRecord(primaryRecord);

  if (vrData) {
    company = enrichWithVr(company, vrData);
  }

  return company;
};

export type SearchOptions = {
  /** Maximum number of results. @default 50 */
  limit?: number;
};

/**
 * Search for Czech economic subjects by company name.
 *
 * @returns A list of matching companies (may be empty).
 * @throws {AresTooBroadError} if the search is too broad
 * @throws {AresAPIError} on ARES API errors
 * @throws {AresRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<AresSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new AresValidationError("Search name must not be empty");
  }

  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;

  const payload = {
    obchodniJmeno: trimmed,
    start: 0,
    pocet: limit,
  };

  const data = await aresPost(SEARCH_URL, payload, isAresSearchResponse);

  return data.ekonomickeSubjekty
    .filter((entry) => entry.ico)
    .map(parseSearchEntry);
};
