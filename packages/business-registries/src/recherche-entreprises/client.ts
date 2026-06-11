import {
  RechercheEntreprisesAPIError,
  RechercheEntreprisesRequestError,
  RechercheEntreprisesValidationError,
} from "./errors.js";
import { parseCompany, parseSearchEntry } from "./parse.js";
import type {
  RechercheEntreprisesCompany,
  RechercheEntreprisesErrorResponse,
  RechercheEntreprisesSearchResponse,
  RechercheEntreprisesSearchResult,
} from "./types.js";
import { normalizeSiren, validateSiren, validateSiret } from "./validation.js";

const BASE = "https://recherche-entreprises.api.gouv.fr";
const SEARCH_URL = `${BASE}/search`;

const TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 25;
// Upstream documents 25 results per page, max per_page = 25 on the
// production endpoint. Clamp client-side so the dispatch layer can
// forward any caller-supplied limit safely.
const MAX_SEARCH_LIMIT = 25;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRechercheEstablishment = (value: unknown): boolean =>
  isRecord(value) && typeof value["siret"] === "string";

const isRechercheDirector = (value: unknown): boolean =>
  isRecord(value) &&
  (value["type_dirigeant"] === "personne physique" ||
    value["type_dirigeant"] === "personne morale");

const isRechercheCompany = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value["siren"] === "string" &&
  typeof value["nom_complet"] === "string" &&
  (value["siege"] === undefined ||
    value["siege"] === null ||
    isRechercheEstablishment(value["siege"])) &&
  (value["matching_etablissements"] === undefined ||
    (Array.isArray(value["matching_etablissements"]) &&
      value["matching_etablissements"].every(isRechercheEstablishment))) &&
  (value["dirigeants"] === undefined ||
    (Array.isArray(value["dirigeants"]) &&
      value["dirigeants"].every(isRechercheDirector)));

const isRechercheSearchResponse = (
  value: unknown,
): value is RechercheEntreprisesSearchResponse =>
  isRecord(value) &&
  Array.isArray(value["results"]) &&
  value["results"].every(isRechercheCompany) &&
  typeof value["total_results"] === "number" &&
  typeof value["page"] === "number" &&
  typeof value["per_page"] === "number" &&
  typeof value["total_pages"] === "number";

const parseErrorBody = (value: unknown): RechercheEntreprisesErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: RechercheEntreprisesErrorResponse = {};
  if (typeof value["message"] === "string") {
    result.message = value["message"];
  }
  if (typeof value["erreur"] === "string") {
    result.erreur = value["erreur"];
  }
  return result;
};

const rechercheEntreprisesGet = async (
  url: string,
): Promise<RechercheEntreprisesSearchResponse> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new RechercheEntreprisesRequestError(
      url,
      "recherche-entreprises request failed",
      { cause: error },
    );
  }

  if (!response.ok) {
    let body: RechercheEntreprisesErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON body
    }
    const upstreamMessage = body.message ?? body.erreur ?? null;
    throw new RechercheEntreprisesAPIError({
      message: `recherche-entreprises ${response.status}: ${upstreamMessage ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // A malformed body on an otherwise-200 response (the upstream
    // very occasionally serves truncated JSON during peak load)
    // would otherwise bubble out as a bare SyntaxError, bypass
    // `mapRechercheEntreprisesError`, and surface as HTTP 500. Wrap
    // it so the dispatch layer translates it to 502 like every other
    // upstream failure.
    throw new RechercheEntreprisesAPIError({
      message: `recherche-entreprises returned an unparseable JSON body (HTTP ${response.status})`,
      httpStatus: response.status,
      upstreamMessage: null,
      cause: error,
    });
  }
  if (!isRechercheSearchResponse(payload)) {
    throw new RechercheEntreprisesAPIError({
      message: `recherche-entreprises returned an unexpected JSON body shape (HTTP ${response.status})`,
      httpStatus: response.status,
      upstreamMessage: null,
    });
  }
  return payload;
};

/**
 * Look up a French entity by SIREN (9 digits).
 *
 * Recherche-entreprises does not expose a dedicated by-SIREN endpoint;
 * the `/search` endpoint accepts a SIREN in `q` and returns at most
 * one matching unité légale. This function collapses an empty results
 * array into `null`.
 *
 * @returns The entity, or `null` if the SIREN is not on file.
 * @throws {RechercheEntreprisesValidationError} when the SIREN fails Luhn
 * @throws {RechercheEntreprisesAPIError} on upstream errors
 * @throws {RechercheEntreprisesRequestError} on network failures
 */
export const lookupBySiren = async (
  siren: string,
): Promise<RechercheEntreprisesCompany | null> => {
  const normalized = normalizeSiren(siren);
  if (!validateSiren(normalized)) {
    throw new RechercheEntreprisesValidationError(`Invalid SIREN: ${siren}`);
  }
  const params = new URLSearchParams({ q: normalized });
  const data = await rechercheEntreprisesGet(
    `${SEARCH_URL}?${params.toString()}`,
  );
  const hit = data.results.at(0);
  // Belt-and-braces: the search endpoint matches `q` against any
  // text field, so an unrelated entity could in principle slip in.
  // Require the SIREN to match exactly before returning the hit.
  if (!hit || hit.siren !== normalized) {
    return null;
  }
  return parseCompany(hit);
};

/**
 * Look up a French establishment by SIRET (14 digits).
 *
 * The SIRET case is dispatched on the same `/search` endpoint with
 * `q=<siret>`. The returned unité légale carries the head office in
 * `siege`; the specific etablissement matched by the SIRET is surfaced
 * in `matchedEstablishment` so callers can render branch-level
 * answers (address of this specific shop, etc.) without re-walking
 * the etablissements list.
 *
 * @returns The entity (with `matchedEstablishment` populated), or
 *   `null` if the SIRET is not on file.
 * @throws {RechercheEntreprisesValidationError} when the SIRET fails Luhn
 *   (or the La Poste divisible-by-5 check for SIRENs starting `356000000`)
 * @throws {RechercheEntreprisesAPIError} on upstream errors
 * @throws {RechercheEntreprisesRequestError} on network failures
 */
export const lookupBySiret = async (
  siret: string,
): Promise<RechercheEntreprisesCompany | null> => {
  const normalized = normalizeSiren(siret);
  if (!validateSiret(normalized)) {
    throw new RechercheEntreprisesValidationError(`Invalid SIRET: ${siret}`);
  }
  const params = new URLSearchParams({ q: normalized });
  const data = await rechercheEntreprisesGet(
    `${SEARCH_URL}?${params.toString()}`,
  );
  // SIRET = SIREN (first 9) + NIC (last 5). Require BOTH the unité
  // légale's SIREN to match the SIRET prefix AND the establishment
  // itself to appear in `matching_etablissements`. Without the second
  // check, a lookup for a non-existent NIC under a known SIREN would
  // silently fall through to the parent unité légale and report it
  // as a successful establishment hit.
  const expectedSiren = normalized.slice(0, 9);
  const hit = data.results.find(
    (entry) =>
      entry.siren === expectedSiren &&
      entry.matching_etablissements?.some(
        (etablissement) => etablissement.siret === normalized,
      ),
  );
  if (!hit) {
    return null;
  }
  return parseCompany(hit, normalized);
};

export type SearchOptions = {
  /**
   * Maximum number of results. Upstream caps each page at 25 — values
   * above are silently clamped down. @default 25
   */
  limit?: number;
};

/**
 * Search recherche-entreprises by company name (case-insensitive,
 * multi-field substring server-side).
 *
 * @returns A list of matching entities (may be empty).
 * @throws {RechercheEntreprisesValidationError} if `name` is empty after trimming
 * @throws {RechercheEntreprisesAPIError} on upstream errors
 * @throws {RechercheEntreprisesRequestError} on network failures
 */
export const searchByName = async (
  name: string,
  options?: SearchOptions,
): Promise<RechercheEntreprisesSearchResult[]> => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new RechercheEntreprisesValidationError(
      "Search name must not be empty",
    );
  }
  const requestedLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const perPage = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT);
  const params = new URLSearchParams({
    q: trimmed,
    per_page: String(perPage),
  });
  const data = await rechercheEntreprisesGet(
    `${SEARCH_URL}?${params.toString()}`,
  );
  return data.results.slice(0, perPage).map(parseSearchEntry);
};
