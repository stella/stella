import {
  ViesAPIError,
  ViesRequestError,
  ViesValidationError,
} from "./errors.js";
import { parseValidation } from "./parse.js";
import type { ViesRawResponse, ViesValidation } from "./types.js";
import {
  isViesParticipant,
  normalizeVatNumber,
  parseVatNumber,
  validateVatFormat,
  VAT_FORMAT_RULES,
} from "./validation.js";

const BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api";
const TIMEOUT_MS = 10_000;

/**
 * Validate an EU VAT number against the VIES (VAT Information
 * Exchange System) REST API.
 *
 * The input must carry the 2-letter country prefix (e.g.
 * "DE143593636"). Spaces, dots, dashes, and slashes inside the
 * string are stripped before the call.
 *
 * @returns The structured validation result. `valid` will be `false`
 *   when the VAT is not registered, when the upstream member-state
 *   service is unavailable, or when the per-country format rule
 *   rejects the input.
 * @throws {ViesValidationError} for inputs missing the country prefix,
 *   for unknown country prefixes, and for prefixes no longer in VIES
 *   (currently only GB after Brexit).
 * @throws {ViesAPIError} on a non-2xx HTTP response.
 * @throws {ViesRequestError} on a network/transport failure.
 */
export const validateVat = async (input: string): Promise<ViesValidation> => {
  const parsed = parseVatNumber(input);
  if (!parsed) {
    throw new ViesValidationError(
      `Invalid VAT number: ${input}. Expected a 2-letter country prefix followed by national VAT digits.`,
    );
  }
  const rule = VAT_FORMAT_RULES[parsed.country];
  if (!rule) {
    throw new ViesValidationError(
      `Unknown VAT country prefix: ${parsed.country}.`,
    );
  }
  if (!isViesParticipant(parsed.country)) {
    throw new ViesValidationError(
      `${parsed.country} VAT numbers are not in VIES (removed after Brexit on 2021-01-01).`,
    );
  }
  if (!rule.pattern.test(parsed.vat)) {
    // Short-circuit malformed national parts before the network
    // round-trip. The REST endpoint returns `userError: "INVALID"`
    // for malformed input, and `parseValidation` maps that to
    // `not-registered` — a misleading "VAT exists but isn't
    // registered" result for what is actually a format violation.
    // Throwing here lets the dispatch layer surface a 400 with a
    // useful message instead.
    throw new ViesValidationError(
      `Invalid VAT format for ${parsed.country}: ${parsed.vat}.`,
    );
  }
  const url = `${BASE}/ms/${parsed.country}/vat/${encodeURIComponent(parsed.vat)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new ViesRequestError(url, "VIES request failed", { cause: error });
  }

  if (!response.ok) {
    throw new ViesAPIError({
      message: `VIES ${response.status}: ${response.statusText}`,
      httpStatus: response.status,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ViesAPIError({
      message: "VIES returned a non-JSON body",
      httpStatus: response.status,
      cause: error,
    });
  }

  if (!isViesRawResponse(body)) {
    throw new ViesAPIError({
      message: "VIES response did not match the expected shape",
      httpStatus: response.status,
    });
  }

  return parseValidation(body, parsed);
};

const isViesRawResponse = (value: unknown): value is ViesRawResponse => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "isValid" in value &&
    typeof value.isValid === "boolean" &&
    "userError" in value &&
    typeof value.userError === "string" &&
    "requestDate" in value &&
    typeof value.requestDate === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "address" in value &&
    typeof value.address === "string"
  );
};

/**
 * Convenience re-export: cheap format check. Useful when callers want
 * to short-circuit before incurring a round-trip to VIES.
 */
export { normalizeVatNumber, validateVatFormat };
