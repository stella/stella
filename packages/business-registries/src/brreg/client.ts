import { encodeRegistryComponent } from "../shared/encode-registry-component.js";
import {
  hasOptionalString,
  hasOptionalNumber,
  isRecord,
  isOptionalArrayOf,
} from "../shared/guards.js";
import { type RegistryClientOptions, registryFetch } from "../shared/http.js";
import { clampSearchLimit } from "../shared/search.js";
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

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const BRREG_RESULT_CAP = 10_000;

const isString = (value: unknown): boolean => typeof value === "string";

const isBrregAddress = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    hasOptionalString(value, "land") &&
    hasOptionalString(value, "postnummer") &&
    hasOptionalString(value, "poststed") &&
    hasOptionalString(value, "kommune") &&
    isOptionalArrayOf(value["adresse"], isString));

const isBrregCode = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    hasOptionalString(value, "kode") &&
    hasOptionalString(value, "beskrivelse"));

const isBrregRawEnhet = (value: unknown): value is BrregRawEnhet =>
  isRecord(value) &&
  typeof value["organisasjonsnummer"] === "string" &&
  typeof value["navn"] === "string" &&
  hasOptionalString(value, "registreringsdatoEnhetsregisteret") &&
  hasOptionalString(value, "stiftelsesdato") &&
  hasOptionalString(value, "slettedato") &&
  hasOptionalString(value, "nedleggelsesdato") &&
  hasOptionalString(value, "konkursdato") &&
  hasOptionalString(value, "underAvviklingDato") &&
  hasOptionalString(value, "tvangsopplostPgaManglendeRegnskapDato") &&
  hasOptionalString(value, "tvangsopplostPgaManglendeRevisorDato") &&
  hasOptionalString(value, "tvangsopplostPgaMangelfulltStyreDato") &&
  hasOptionalString(value, "tvangsopplostPgaManglendeDagligLederDato") &&
  hasOptionalString(value, "tvangsavvikletPgaManglendeSlettingDato") &&
  hasOptionalNumber(value, "antallAnsatte") &&
  (value["konkurs"] === undefined || typeof value["konkurs"] === "boolean") &&
  (value["underAvvikling"] === undefined ||
    typeof value["underAvvikling"] === "boolean") &&
  (value["underTvangsavviklingEllerTvangsopplosning"] === undefined ||
    typeof value["underTvangsavviklingEllerTvangsopplosning"] === "boolean") &&
  (value["registrertIMvaregisteret"] === undefined ||
    typeof value["registrertIMvaregisteret"] === "boolean") &&
  isBrregCode(value["organisasjonsform"]) &&
  isBrregAddress(value["forretningsadresse"]) &&
  isBrregAddress(value["beliggenhetsadresse"]) &&
  isBrregAddress(value["postadresse"]) &&
  isBrregCode(value["naeringskode1"]) &&
  isBrregCode(value["naeringskode2"]) &&
  isBrregCode(value["naeringskode3"]);

const isBrregSearchResponse = (
  value: unknown,
): value is BrregSearchResponse => {
  if (!isRecord(value)) {
    return false;
  }

  const embedded = value["_embedded"];
  if (embedded !== undefined) {
    if (!isRecord(embedded)) {
      return false;
    }
    const enheter = embedded["enheter"];
    if (!Array.isArray(enheter) || !enheter.every(isBrregRawEnhet)) {
      return false;
    }
  }

  const page = value["page"];
  if (page === undefined) {
    return true;
  }
  return (
    isRecord(page) &&
    typeof page["size"] === "number" &&
    typeof page["totalElements"] === "number" &&
    typeof page["totalPages"] === "number" &&
    typeof page["number"] === "number"
  );
};

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

type BrregGetOptions<T> = RegistryClientOptions & {
  isExpectedShape: (value: unknown) => value is T;
};

const brregGet = async <T>(
  url: string,
  { isExpectedShape, ...options }: BrregGetOptions<T>,
): Promise<T | null> =>
  await registryFetch({
    url,
    observer: options.observer,
    signal: options.signal,
    init: { headers: { Accept: "application/json" } },
    isExpectedShape,
    wrapRequestError: (cause) =>
      new BrregRequestError(url, "Brreg request failed", { cause }),
    wrapParseError: (response, cause) =>
      new BrregAPIError({
        message: "Brreg returned a non-JSON response",
        httpStatus: response.status,
        cause,
      }),
    wrapShapeError: (response) =>
      new BrregAPIError({
        message: "Brreg returned an unexpected response shape",
        httpStatus: response.status,
      }),
    onErrorResponse: async (response) => {
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
    },
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LookupOptions = RegistryClientOptions & {
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
  options: LookupOptions,
): Promise<BrregEntity | null> => {
  const normalized = normalizeOrgnr(orgnr);

  if (!validateOrgnr(normalized)) {
    throw new BrregValidationError(`Invalid orgnr: ${orgnr}`);
  }

  const enhet = await brregGet(
    `${ENHETER_URL}/${encodeRegistryComponent(normalized)}`,
    { ...options, isExpectedShape: isBrregRawEnhet },
  );
  if (enhet) {
    return parseEnhet(enhet, "enhet");
  }

  if (options.includeSubEntities ?? true) {
    const sub = await brregGet(
      `${UNDERENHETER_URL}/${encodeRegistryComponent(normalized)}`,
      { ...options, isExpectedShape: isBrregRawEnhet },
    );
    if (sub) {
      return parseEnhet(sub, "underenhet");
    }
  }

  return null;
};

export type SearchOptions = RegistryClientOptions & {
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
  options: SearchOptions,
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

  const requestedLimit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const size = clampSearchLimit(requestedLimit, MAX_SEARCH_LIMIT);

  const params = new URLSearchParams({
    navn: trimmed,
    size: String(size),
  });
  const url = `${ENHETER_URL}?${params.toString()}`;

  let data: BrregSearchResponse | null;
  try {
    data = await brregGet(url, {
      ...options,
      isExpectedShape: isBrregSearchResponse,
    });
  } catch (error) {
    // Brreg short-circuits queries that would exceed its 10k result
    // cap with HTTP 400 — there is no page envelope to inspect — so
    // we translate that 400 into the intended "refine your query"
    // signal instead of letting the handler treat it as a 502.
    // Other 400s (malformed query syntax etc.) propagate as-is; we
    // construct the query ourselves so they should not happen in
    // practice.
    if (error instanceof BrregAPIError && error.httpStatus === 400) {
      throw new BrregTooBroadError(trimmed);
    }
    throw error;
  }
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
