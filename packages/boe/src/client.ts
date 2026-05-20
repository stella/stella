import {
  BoeAPIError,
  BoeNotFoundError,
  BoeRequestError,
  BoeValidationError,
} from "./errors.js";
import { buildSearchQuery } from "./query.js";
import type { BoeSearchQuery } from "./query.js";
import type {
  BoeErrorResponse,
  BoeLawEnvelope,
  BoeSearchResponse,
  BormeSummaryResponse,
  ConsolidatedLawResult,
  ConsolidatedLawSections,
} from "./types.js";
import { validateBoeDate, validateLawId } from "./validation.js";

const BASE = "https://www.boe.es/datosabiertos/api";

const LEGISLATION_ENDPOINT = `${BASE}/legislacion-consolidada`;
const BOE_SUMMARY_ENDPOINT = `${BASE}/boe/sumario`;
const BORME_SUMMARY_ENDPOINT = `${BASE}/borme/sumario`;

const TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseErrorBody = (value: unknown): BoeErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: BoeErrorResponse = {};
  if (isRecord(value["status"])) {
    const status: { code?: string; text?: string } = {};
    if (typeof value["status"]["code"] === "string") {
      status.code = value["status"]["code"];
    }
    if (typeof value["status"]["text"] === "string") {
      status.text = value["status"]["text"];
    }
    result.status = status;
  }
  return result;
};

const boeFetch = async (
  url: string,
  accept: string,
): Promise<Response | null> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: accept },
    });
  } catch (error) {
    throw new BoeRequestError(url, "BOE request failed", { cause: error });
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    let body: BoeErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON error body; leave defaults
    }
    throw new BoeAPIError({
      message: `BOE ${response.status}: ${body.status?.text ?? response.statusText}`,
      httpStatus: response.status,
      boeStatus: body.status?.code ?? null,
    });
  }

  return response;
};

const boeGet = async <T>(url: string): Promise<T | null> => {
  const response = await boeFetch(url, "application/json");
  if (response === null) {
    return null;
  }
  // SAFETY: we trust the BOE open-data API to return the documented JSON shape;
  // runtime validation across every nested branch is impractical for this
  // undocumented-but-stable public API.
  // oxlint-disable-next-line no-unsafe-type-assertion
  return response.json() as Promise<T>;
};

// The BOE API serves /texto and /texto/bloque/{id} as application/xml only.
const boeGetText = async (url: string): Promise<string | null> => {
  const response = await boeFetch(url, "application/xml");
  if (response === null) {
    return null;
  }
  return await response.text();
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchLegislationOptions = BoeSearchQuery & {
  /** Zero-based offset into the result set. @default 0 */
  offset?: number | undefined;
  /** Maximum results to return. @default 25, max 100 */
  limit?: number | undefined;
};

/**
 * Search the consolidated legislation index (~50,000 norms).
 *
 * @throws {BoeAPIError} on BOE API errors
 * @throws {BoeRequestError} on network failures
 */
export const searchConsolidatedLegislation = async (
  options: SearchLegislationOptions,
): Promise<BoeSearchResponse> => {
  const limit = Math.min(
    options.limit ?? DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const offset = options.offset ?? 0;

  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });

  // Date filters live inside the JSON DSL (range.fecha_publicacion).
  // The top-level `from` / `to` URL params on this endpoint filter by
  // last-update date, not publication date, so passing them would
  // double-bound the results.
  const queryDsl = buildSearchQuery(options);
  if (queryDsl) {
    params.set("query", queryDsl);
  }

  const url = `${LEGISLATION_ENDPOINT}?${params.toString()}`;
  const data = await boeGet<BoeSearchResponse>(url);
  return data ?? { data: [], status: { code: "200", text: "ok" } };
};

// ---------------------------------------------------------------------------
// Single-law fetches
// ---------------------------------------------------------------------------

const lawSectionUrl = (lawId: string, section?: string): string => {
  const base = `${LEGISLATION_ENDPOINT}/id/${lawId}`;
  return section ? `${base}/${section}` : base;
};

const fetchLawJsonSection = async (
  lawId: string,
  section: string,
): Promise<unknown> => {
  const envelope = await boeGet<BoeLawEnvelope>(lawSectionUrl(lawId, section));
  if (envelope === null) {
    throw new BoeNotFoundError(`${lawId}/${section}`);
  }
  return envelope.data ?? null;
};

// Returns null on 404 instead of throwing — used for optional sections of a law
// that may be missing without invalidating the rest of the response.
const fetchOptionalLawJsonSection = async (
  lawId: string,
  section: string,
): Promise<unknown> => {
  const envelope = await boeGet<BoeLawEnvelope>(lawSectionUrl(lawId, section));
  return envelope === null ? null : (envelope.data ?? null);
};

const fetchOptionalLawXmlSection = async (
  lawId: string,
  section: string,
): Promise<string | null> => await boeGetText(lawSectionUrl(lawId, section));

export type GetConsolidatedLawOptions = {
  metadata?: boolean | undefined;
  analysis?: boolean | undefined;
  fullText?: boolean | undefined;
  eli?: boolean | undefined;
};

/**
 * Fetch a consolidated law by its BOE identifier (e.g. `BOE-A-1889-4763`).
 * Sections are requested in parallel; pass flags to skip ones you don't need.
 *
 * @throws {BoeValidationError} if `lawId` does not match the BOE pattern
 * @throws {BoeNotFoundError} if the law id does not exist
 * @throws {BoeAPIError} on BOE API errors
 * @throws {BoeRequestError} on network failures
 */
export const getConsolidatedLaw = async (
  lawId: string,
  options?: GetConsolidatedLawOptions,
): Promise<ConsolidatedLawResult> => {
  if (!validateLawId(lawId)) {
    throw new BoeValidationError(`Invalid BOE law id: ${lawId}`);
  }

  const sections: ConsolidatedLawSections = {
    metadata: options?.metadata ?? true,
    analysis: options?.analysis ?? true,
    fullText: options?.fullText ?? false,
    eli: options?.eli ?? false,
  };

  // metadatos is the canonical "does this law exist" probe; the others can
  // legitimately be missing for older or partially-published laws and must
  // not fail the whole request. /texto and /metadata-eli are
  // application/xml only on this API.
  const [metadata, analysis, fullText, eli] = await Promise.all([
    sections.metadata
      ? fetchLawJsonSection(lawId, "metadatos")
      : Promise.resolve(null),
    sections.analysis
      ? fetchOptionalLawJsonSection(lawId, "analisis")
      : Promise.resolve(null),
    sections.fullText
      ? fetchOptionalLawXmlSection(lawId, "texto")
      : Promise.resolve(null),
    sections.eli
      ? fetchOptionalLawXmlSection(lawId, "metadata-eli")
      : Promise.resolve(null),
  ]);

  return { lawId, metadata, analysis, fullText, eli };
};

/**
 * Fetch the table of contents (articles, dispositions, annexes) for a law.
 *
 * @throws {BoeValidationError} on invalid law id
 * @throws {BoeNotFoundError} if the law id does not exist
 */
export const getLawStructure = async (lawId: string): Promise<unknown> => {
  if (!validateLawId(lawId)) {
    throw new BoeValidationError(`Invalid BOE law id: ${lawId}`);
  }
  return await fetchLawJsonSection(lawId, "texto/indice");
};

/**
 * Fetch a single article or disposition (block) of a law.
 *
 * @throws {BoeValidationError} on invalid law id or empty block id
 * @throws {BoeNotFoundError} if the block does not exist
 */
export const getLawTextBlock = async (
  lawId: string,
  blockId: string,
): Promise<string> => {
  if (!validateLawId(lawId)) {
    throw new BoeValidationError(`Invalid BOE law id: ${lawId}`);
  }
  if (!blockId.trim()) {
    throw new BoeValidationError("Block id must not be empty");
  }
  const xml = await boeGetText(
    lawSectionUrl(lawId, `texto/bloque/${encodeURIComponent(blockId)}`),
  );
  if (xml === null) {
    throw new BoeNotFoundError(`${lawId}/texto/bloque/${blockId}`);
  }
  return xml;
};

export const RELATION_TYPES = {
  modifies: "modifies",
  modifiedBy: "modifiedBy",
  derogates: "derogates",
  derogatedBy: "derogatedBy",
  all: "all",
} as const;

export type RelationType = (typeof RELATION_TYPES)[keyof typeof RELATION_TYPES];

export type RelatedLawsResult = {
  lawId: string;
  relationType: RelationType;
  /** Raw analysis envelope; consumers filter the relations they need. */
  analysis: unknown;
};

/**
 * Fetch the legal-analysis section, which lists every modification/derogation
 * relationship for a law. Filtering by `relationType` is left to consumers
 * because the BOE response groups relations under several keys whose shape
 * varies; returning the raw analysis avoids lossy filtering on our side.
 */
export const findRelatedLaws = async (
  lawId: string,
  relationType: RelationType = RELATION_TYPES.all,
): Promise<RelatedLawsResult> => {
  if (!validateLawId(lawId)) {
    throw new BoeValidationError(`Invalid BOE law id: ${lawId}`);
  }
  const analysis = await fetchLawJsonSection(lawId, "analisis");
  return { lawId, relationType, analysis };
};

// ---------------------------------------------------------------------------
// BORME daily summary
// ---------------------------------------------------------------------------

/**
 * Fetch the BORME (commercial registry gazette) summary for a given date.
 *
 * @param date YYYYMMDD
 * @throws {BoeValidationError} on invalid date format
 * @throws {BoeNotFoundError} if no BORME was published that day
 */
export const getBormeSummary = async (
  date: string,
): Promise<BormeSummaryResponse> => {
  if (!validateBoeDate(date)) {
    throw new BoeValidationError(
      `Invalid BOE date (expected YYYYMMDD): ${date}`,
    );
  }
  const url = `${BORME_SUMMARY_ENDPOINT}/${date}`;
  const data = await boeGet<BormeSummaryResponse>(url);
  if (data === null) {
    throw new BoeNotFoundError(`borme/${date}`);
  }
  return data;
};

/**
 * Fetch the BOE daily summary for a given date. Exposed for completeness;
 * not currently surfaced as a chat tool.
 */
export const getBoeSummary = async (
  date: string,
): Promise<Record<string, unknown>> => {
  if (!validateBoeDate(date)) {
    throw new BoeValidationError(
      `Invalid BOE date (expected YYYYMMDD): ${date}`,
    );
  }
  const url = `${BOE_SUMMARY_ENDPOINT}/${date}`;
  const data = await boeGet<Record<string, unknown>>(url);
  if (data === null) {
    throw new BoeNotFoundError(`boe/${date}`);
  }
  return data;
};
