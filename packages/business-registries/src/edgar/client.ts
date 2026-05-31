import {
  EdgarAPIError,
  EdgarRequestError,
  EdgarValidationError,
} from "./errors.js";
import { parseSubmission } from "./parse.js";
import type { EdgarCompany, EdgarRawSubmission } from "./types.js";
import { padCik, validateCik } from "./validation.js";

const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";
const TIMEOUT_MS = 10_000;

// The SEC publishes a hard rule: every request to data.sec.gov and
// www.sec.gov MUST identify the caller via a `User-Agent` header
// (e.g. "Sample Company Name AdminContact@<sample-company-domain>").
// Requests without one come back as HTTP 403, regardless of IP. We
// surface this as a required adapter option rather than a silent
// default; a fake or generic UA risks getting the calling host
// blocked from EDGAR entirely.
//
// See: https://www.sec.gov/os/accessing-edgar-data
export type EdgarClientConfig = {
  /**
   * Identifying string sent in the `User-Agent` header on every
   * EDGAR request. The SEC asks for "<App name> <contact@email>";
   * anything obviously fake (e.g. `"stella"` alone) risks a block.
   */
  userAgent: string;
};

const assertUserAgent = (userAgent: string): void => {
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) {
    throw new EdgarValidationError(
      "SEC EDGAR requires a User-Agent header identifying the caller (e.g. '<App name> <contact@email>'); requests without one return 403",
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const edgarGet = async <T>(
  url: string,
  userAgent: string,
): Promise<T | null> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
        // The SEC docs recommend `Accept-Encoding: gzip, deflate` to
        // reduce bandwidth; Bun's fetch already negotiates this.
        Host: "data.sec.gov",
      },
    });
  } catch (error) {
    throw new EdgarRequestError(url, "EDGAR request failed", { cause: error });
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status === 403) {
    // 403 is almost always a missing or unrecognised User-Agent; flag
    // it distinctly from generic 5xx so operators know to fix the env.
    throw new EdgarAPIError({
      message:
        "EDGAR returned 403 (likely missing or rejected User-Agent header). Set EDGAR_USER_AGENT to '<App name> <contact@email>'.",
      httpStatus: 403,
    });
  }

  if (!response.ok) {
    let upstreamMessage: string | null = null;
    try {
      const body = await response.text();
      upstreamMessage = body.length > 0 ? body.slice(0, 200) : null;
    } catch {
      // non-readable body
    }
    throw new EdgarAPIError({
      message: `EDGAR ${response.status}: ${upstreamMessage ?? response.statusText}`,
      httpStatus: response.status,
      upstreamMessage,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new EdgarAPIError({
      message: "EDGAR returned a non-JSON response",
      httpStatus: response.status,
      cause: error,
    });
  }
  if (!isRecord(json)) {
    throw new EdgarAPIError({
      message: "EDGAR returned an unexpected response shape",
      httpStatus: response.status,
    });
  }
  // SAFETY: EDGAR's `submissions/CIK*.json` is a documented, stable
  // public endpoint. The parser tolerates absent fields, so we narrow
  // structurally at the top (`isRecord`) and let the parser handle
  // the rest.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return json as T;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a US public-company filer by Central Index Key.
 *
 * @returns The company submission record, or `null` if the CIK has
 *   never been registered with the SEC.
 * @throws {EdgarValidationError} if the CIK fails shape validation or
 *   the configured `userAgent` is empty.
 * @throws {EdgarAPIError} on EDGAR API errors (including 403 when the
 *   `User-Agent` header is missing or rejected).
 * @throws {EdgarRequestError} on network failures.
 */
export const lookupByCik = async (
  cik: string,
  config: EdgarClientConfig,
): Promise<EdgarCompany | null> => {
  assertUserAgent(config.userAgent);

  if (!validateCik(cik)) {
    throw new EdgarValidationError(`Invalid CIK: ${cik}`);
  }

  const padded = padCik(cik);
  const url = `${SUBMISSIONS_BASE}/CIK${padded}.json`;
  const raw = await edgarGet<EdgarRawSubmission>(url, config.userAgent);
  if (!raw) {
    return null;
  }
  return parseSubmission(raw);
};
