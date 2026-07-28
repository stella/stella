import { isRecord } from "../shared/guards.js";
import { performRegistryRequest } from "../shared/http.js";
import { clampSearchLimit } from "../shared/search.js";
import {
  ZefixAPIError,
  ZefixRequestError,
  ZefixValidationError,
} from "./errors.js";
import { parseFirm, parseSearchEntry } from "./parse.js";
import type {
  ZefixCompany,
  ZefixRawFirm,
  ZefixSearchResponse,
  ZefixSearchResult,
} from "./types.js";
import { normalizeUid, validateUid } from "./validation.js";

const SEARCH_URL = "https://www.zefix.ch/ZefixREST/api/v1/firm/search.json";
const NO_RESULT_CODE = "API.ZFR.SEARCH.NORESULT";
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 50;

const isOptionalString = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === "string";

const isZefixRawFirm = (value: unknown): value is ZefixRawFirm =>
  isRecord(value) &&
  isOptionalString(value["name"]) &&
  isOptionalString(value["uid"]) &&
  isOptionalString(value["uidFormatted"]);

type ZefixSuccessfulSearchResponse = ZefixSearchResponse & {
  list: ZefixRawFirm[];
};

const isZefixSearchResponse = (
  value: unknown,
): value is ZefixSuccessfulSearchResponse =>
  isRecord(value) &&
  Array.isArray(value["list"]) &&
  value["list"].every(isZefixRawFirm) &&
  (value["error"] === undefined || isRecord(value["error"]));

const getErrorCode = (value: unknown): string | null => {
  if (!isRecord(value) || !isRecord(value["error"])) {
    return null;
  }
  return typeof value["error"]["code"] === "string"
    ? value["error"]["code"]
    : null;
};

const zefixSearch = async (
  nameOrId: string,
  maxEntries: number,
): Promise<ZefixSuccessfulSearchResponse | null> => {
  const response = await performRegistryRequest({
    url: SEARCH_URL,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        languageKey: "en",
        maxEntries,
        offset: 0,
        name: nameOrId,
        searchType: "exact",
      }),
    },
    wrapRequestError: (cause) =>
      new ZefixRequestError(SEARCH_URL, "Zefix request failed", { cause }),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ZefixAPIError({
      message: `Zefix ${response.status}: invalid JSON payload`,
      httpStatus: response.status,
      cause: error,
    });
  }

  const errorCode = getErrorCode(body);
  if (response.status === 404 && errorCode === NO_RESULT_CODE) {
    return null;
  }
  if (!response.ok) {
    throw new ZefixAPIError({
      message: `Zefix ${response.status}: ${errorCode ?? response.statusText}`,
      httpStatus: response.status,
      upstreamCode: errorCode,
    });
  }
  if (!isZefixSearchResponse(body)) {
    throw new ZefixAPIError({
      message: "Zefix returned an unexpected response shape",
      httpStatus: response.status,
    });
  }
  return body;
};

export const lookupByUid = async (
  uidInput: string,
): Promise<ZefixCompany | null> => {
  const uid = normalizeUid(uidInput);
  if (!validateUid(uid)) {
    throw new ZefixValidationError(`Invalid Swiss UID: ${uidInput}`);
  }

  const response = await zefixSearch(uid, 2);
  if (!response) {
    return null;
  }
  for (const entry of response.list) {
    const company = parseFirm(entry);
    if (company?.uid === uid) {
      return company;
    }
  }
  return null;
};

export type SearchOptions = {
  /** Maximum number of results. @default 50 */
  limit?: number;
};

export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<ZefixSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ZefixValidationError("Search name must not be empty");
  }
  const limit = clampSearchLimit(
    options?.limit ?? DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const response = await zefixSearch(trimmed, limit);
  if (!response) {
    return [];
  }
  const results: ZefixSearchResult[] = [];
  for (const entry of response.list) {
    const result = parseSearchEntry(entry);
    if (result) {
      results.push(result);
    }
  }
  return results;
};
