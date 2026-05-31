import { KrsAPIError, KrsRequestError, KrsValidationError } from "./errors.js";
import { parseEntity } from "./parse.js";
import type {
  KrsEntity,
  KrsErrorResponse,
  KrsLookupResponse,
  KrsRegisterCode,
} from "./types.js";
import { normalizeKrsNumber, validateKrsNumber } from "./validation.js";

const BASE = "https://api-krs.ms.gov.pl/api/krs";

const TIMEOUT_MS = 10_000;

// Default probe order: Rejestr Przedsiębiorców (companies) first,
// Stowarzyszeń (associations) second. The same KRS number lives in
// exactly one register, so the second probe runs only on a 404 from
// the first. Honour the documented ~5 rps soft cap by issuing the
// second probe sequentially rather than racing.
const REGISTER_PROBE_ORDER: readonly KrsRegisterCode[] = ["RejP", "RejS"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseErrorBody = (value: unknown): KrsErrorResponse => {
  if (!isRecord(value)) {
    return {};
  }
  const result: KrsErrorResponse = {};
  if (typeof value["type"] === "string") {
    result.type = value["type"];
  }
  if (typeof value["title"] === "string") {
    result.title = value["title"];
  }
  if (typeof value["status"] === "number") {
    result.status = value["status"];
  }
  if (typeof value["detail"] === "string") {
    result.detail = value["detail"];
  }
  if (typeof value["traceId"] === "string") {
    result.traceId = value["traceId"];
  }
  return result;
};

const krsGet = async (
  url: string,
): Promise<{ status: number; body: KrsLookupResponse | null }> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new KrsRequestError(url, "KRS request failed", { cause: error });
  }

  if (response.status === 404) {
    // KRS returns a JSON problem-details body on 404; we don't read
    // it here because the not-found case is signalled by status
    // alone and we want a single round-trip per probe.
    return { status: 404, body: null };
  }

  if (!response.ok) {
    let body: KrsErrorResponse = {};
    try {
      body = parseErrorBody(await response.json());
    } catch {
      // non-JSON body
    }
    throw new KrsAPIError({
      message: `KRS ${response.status}: ${body.title ?? response.statusText}`,
      httpStatus: response.status,
      upstreamTitle: body.title ?? null,
      upstreamDetail: body.detail ?? null,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new KrsAPIError({
      message: `KRS ${response.status}: invalid JSON payload`,
      httpStatus: response.status,
      cause: error,
    });
  }
  // SAFETY: the KRS API is a stable, documented public surface and
  // the shape is captured by `KrsLookupResponse`. The parser
  // tolerates absent optional fields via defensive `?.` chains, so a
  // runtime schema mismatch surfaces as `null` properties on the
  // domain output rather than a 500.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { status: response.status, body: body as KrsLookupResponse };
};

const buildLookupUrl = (
  krsNumber: string,
  register: KrsRegisterCode,
): string => {
  // `rejestr` carries the API short code (`P` / `S`); the API does
  // not accept the long form (`RejP` / `RejS`) here.
  const shortCode = register === "RejP" ? "P" : "S";
  const params = new URLSearchParams({
    rejestr: shortCode,
    format: "json",
  });
  return `${BASE}/OdpisAktualny/${krsNumber}?${params.toString()}`;
};

export type LookupOptions = {
  /**
   * Restrict the probe to a single sub-register. By default the
   * client probes Rejestr Przedsiębiorców (`RejP`) first and falls
   * back to Rejestr Stowarzyszeń (`RejS`) on 404. Pass `RejS` (or
   * `RejP`) to skip the fallback when the caller already knows the
   * register.
   */
  register?: KrsRegisterCode;
};

/**
 * Look up a Polish entity by KRS number.
 *
 * KRS returns HTTP 404 with an RFC 7807 problem body for missing
 * numbers; this function collapses that into `null`. The same KRS
 * number lives in exactly one sub-register (Przedsiębiorców or
 * Stowarzyszeń), so a 404 on the first probe triggers a second
 * probe against the other register before returning `null`.
 *
 * @returns The entity, or `null` when neither sub-register holds
 *   a record for the given KRS number.
 * @throws {KrsValidationError} when the KRS number is not a
 *   10-digit string after normalisation
 * @throws {KrsAPIError} on KRS API errors (non-200, non-404)
 * @throws {KrsRequestError} on network failures
 */
export const lookupByKrsNumber = async (
  krsNumber: string,
  options?: LookupOptions,
): Promise<KrsEntity | null> => {
  const normalized = normalizeKrsNumber(krsNumber);
  if (!validateKrsNumber(normalized)) {
    throw new KrsValidationError(
      `Invalid KRS number: ${krsNumber} (expected 10 digits)`,
    );
  }
  const registers =
    options?.register === undefined ? REGISTER_PROBE_ORDER : [options.register];
  for (const register of registers) {
    const { status, body } = await krsGet(buildLookupUrl(normalized, register));
    if (status === 404 || !body?.odpis) {
      continue;
    }
    return parseEntity(body, normalized);
  }
  return null;
};
