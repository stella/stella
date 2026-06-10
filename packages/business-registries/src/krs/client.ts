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

/**
 * api-krs.ms.gov.pl serves an incomplete TLS chain (leaf only); browsers and
 * curl recover via AIA fetching, but Bun's fetch fails with "unable to verify
 * the first certificate". Pin the chain's public Certum certificates (Bun's
 * `ca` replaces the default trust store, so the root rides along with the
 * missing intermediate) through Bun's non-standard `tls` fetch option. Other
 * runtimes ignore the extra option and use their own trust handling.
 */
const CERTUM_OV_TLS_G2_R39_CA = `-----BEGIN CERTIFICATE-----
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
el23wRxXFIL7DPC9VE11xA==
-----END CERTIFICATE-----`;

const CERTUM_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwDCCA6igAwIBAgIQHr9ZULjJgDdMBvfrVU+17TANBgkqhkiG9w0BAQ0FADB6
MQswCQYDVQQGEwJQTDEhMB8GA1UEChMYQXNzZWNvIERhdGEgU3lzdGVtcyBTLkEu
MScwJQYDVQQLEx5DZXJ0dW0gQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxHzAdBgNV
BAMTFkNlcnR1bSBUcnVzdGVkIFJvb3QgQ0EwHhcNMTgwMzE2MTIxMDEzWhcNNDMw
MzE2MTIxMDEzWjB6MQswCQYDVQQGEwJQTDEhMB8GA1UEChMYQXNzZWNvIERhdGEg
U3lzdGVtcyBTLkEuMScwJQYDVQQLEx5DZXJ0dW0gQ2VydGlmaWNhdGlvbiBBdXRo
b3JpdHkxHzAdBgNVBAMTFkNlcnR1bSBUcnVzdGVkIFJvb3QgQ0EwggIiMA0GCSqG
SIb3DQEBAQUAA4ICDwAwggIKAoICAQDRLY67tzbqbTeRn06TpwXkKQMlzhyC93yZ
n0EGze2jusDbCSzBfN8pfktlL5On1AFrAygYo9idBcEq2EXxkd7fO9CAAozPOA/q
p1x4EaTByIVcJdPTsuclzxFUl6s1wB52HO8AU5853BSlLCIls3Jy/I2z5T4IHhQq
NwuIPMqw9MjCoa68wb4pZ1Xi/K1ZXP69VyywkI3C7Te2fJmItdUDmj0VDT06qKhF
8JVOJVkdzZhpu9PMMsmN74H+rX2Ju7pgE8pllWeg8xn2A1bUatMn4qGtg/BKEiJ3
HAVz4hlxQsDsdUaakFjgao4rpUYwBI4Zshfjvqm6f1bxJAPXsiEodg42MEx51UGa
mqi4NboMOvJEGyCI98Ul1z3G4z5D3Yf+xOr1Uz5MZf87Sst4WmsXXw3Hw09Omiqi
7VdNIuJGmj8PkTQkfVXjjJU30xrwCSss0smNtA0Aq2cpKNgB9RkEth2+dv5yXMSF
ytKAQd8FqKPVhJBPC/PgP5sZ0jeJP/J7UhyM9uH3PAeXjA6iWYEMspA90+NZRu0P
qafegGtaqge2Gcu8V/OXIXoMsSt0Puvap2ctTMSYnjYJdmZm/Bo/6khUHL4wvYBQ
v3y1zgD2DGHZ5yQD4OMBgQ692IU0iL2yNqh7XAjlRICMb/gv1SHKHRzQ+8S1h9E6
Tsd2tTVItQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSM+xx1
vALTn04uSNn5YFSqxLNP+jAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQENBQAD
ggIBAEii1QALLtA/vBzVtVRJHlpr9OTy4EA34MwUe7nJ+jW1dReTagVphZzNTxl4
WxmB82M+w85bj/UvXgF2Ez8sALnNllI5SW0ETsXpD4YN4fqzX4IS8TrOZgYkNCvo
zMrnadyHncI013nR03e4qllY/p0m+jiGPp2Kh2RX5Rc64vmNueMzeMGQ2Ljdt4NR
5MTMI9UGfOZR0800McD2RrsLrfw9EAUqO0qRJe6M1ISHgCq8CYyqOhNf6DR5UMEQ
GfnTKB7U0VEwKbOukGfWHwpjscWpxkIxYxeU72nLL/qMFH3EQxiJ2fAyQOaA4kZf
5ePBAFmo+eggvIksDkc0C+pXwlM2/KfUrzHN/gLldfq5Jwn58/U7yn2fqSLLiMmq
0Uc9NneoWWRrJ8/vJ8HjJLWG965+Mk2weWjROeiQWMODvA8s1pfrzgzhIMfatz7D
P78v3DSk+yshzWePS/Tj6tQ/50+6uaWTRRxmHyH6ZF5v4HaUMst19W7l9o/HuKTM
qJZ9ZPskWkoDbGs4xugDQ5r3V7mzKWmTOPQD8rv7gmsHINFSH5pkAnuYZttcTVoP
0ISVoDwUQwbKytu4QTbaakRnh6+v40URFWkIsr4WOZckbxJF0WddCajJFdr60qZf
E2Efv4WstK2tBZQIgx51F9NxO5NQI1mg7TyRVJ12AMXDuDjb
-----END CERTIFICATE-----`;

/** Bun extends RequestInit with a `tls` option that standard lib types do
 *  not model; the runtime guard below scopes its use to Bun. */
type BunTlsRequestInit = RequestInit & {
  tls?: { ca: string[] };
};

const krsFetchOptions = (): RequestInit => {
  const base: BunTlsRequestInit = {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json" },
  };
  if (typeof Bun === "undefined") {
    return base;
  }
  base.tls = { ca: [CERTUM_OV_TLS_G2_R39_CA, CERTUM_TRUSTED_ROOT_CA] };
  return base;
};

const krsGet = async (
  url: string,
): Promise<{ status: number; body: KrsLookupResponse | null }> => {
  let response: Response;
  try {
    response = await fetch(url, krsFetchOptions());
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new KrsRequestError(url, `KRS request failed${cause}`, {
      cause: error,
    });
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
