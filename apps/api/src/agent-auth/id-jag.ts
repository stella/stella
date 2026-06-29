import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { FetchImplementation, JWTPayload, JWTVerifyGetKey } from "jose";

import {
  AGENT_AUTH_ID_JAG_ALLOWED_ALGS,
  AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS,
  AGENT_AUTH_ID_JAG_JWT_TYP,
  AGENT_AUTH_ID_JAG_MAX_AUTH_AGE_SECONDS,
  AGENT_AUTH_JWKS_CACHE_MAX_MS,
  AGENT_AUTH_JWKS_CACHE_MIN_MS,
  AGENT_AUTH_JWKS_FETCH_TIMEOUT_MS,
} from "@/api/agent-auth/constants";
import {
  agentAssertionReplay,
  agentTrustedIssuer,
} from "@/api/db/agent-auth-schema";
import { rootDb } from "@/api/db/root";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";

/**
 * The error vocabulary the ID-JAG path maps onto HTTP. `issuer_not_enabled`
 * is the dark-launch / untrusted-issuer rejection; `login_required` is a
 * stale `auth_time`; `invalid_assertion` covers every other validation
 * failure so a caller cannot distinguish a bad signature from a bad claim
 * (no oracle for forging assertions).
 */
export type IdJagErrorCode =
  | "issuer_not_enabled"
  | "login_required"
  | "invalid_assertion";

export class IdJagValidationError {
  readonly code: IdJagErrorCode;
  readonly message: string;
  constructor(code: IdJagErrorCode, message: string) {
    this.code = code;
    this.message = message;
  }
}

/**
 * The trusted, verified facts an ID-JAG yields once every check passes.
 * `email` is always verified (one of `email_verified` /
 * `phone_number_verified` was true) before this is produced.
 */
export type ValidatedIdJag = {
  iss: string;
  sub: string;
  email: string;
  jti: string;
  /** Assertion `exp` as a Date; used to bound the replay-store row. */
  expiresAt: Date;
};

type TrustedIssuerRow = {
  issuer: string;
  enabled: boolean;
  attestationPolicy: unknown;
};

/**
 * Per-issuer JWKS resolvers, keyed by issuer. `createRemoteJWKSet`
 * implements the Cache-Control-honoring cache + kid-miss refetch the
 * spec wants; one resolver per issuer keeps that cache warm across
 * requests within the process.
 */
const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

/**
 * Fetch the JWKS over HTTPS only. jose passes its own `timeoutDuration`
 * abort signal in `options`; routing through `customFetch` lets us also
 * reject a non-HTTPS JWKS URL defensively (the issuer is already required
 * to be HTTPS, so this is belt-and-braces).
 */
const httpsOnlyFetch: FetchImplementation = async (url, options) => {
  if (!isHttpsUrl(url)) {
    throw new Error("JWKS must be served over HTTPS.");
  }
  return await fetch(url, options);
};

const getJwksFor = (issuer: string): JWTVerifyGetKey => {
  const existing = jwksByIssuer.get(issuer);
  if (existing) {
    return existing;
  }
  const jwksUrl = new URL(
    ".well-known/jwks.json",
    `${issuer.replace(/\/$/u, "")}/`,
  );
  const resolver = createRemoteJWKSet(jwksUrl, {
    cacheMaxAge: AGENT_AUTH_JWKS_CACHE_MAX_MS,
    cooldownDuration: AGENT_AUTH_JWKS_CACHE_MIN_MS,
    timeoutDuration: AGENT_AUTH_JWKS_FETCH_TIMEOUT_MS,
    [customFetch]: httpsOnlyFetch,
  });
  jwksByIssuer.set(issuer, resolver);
  return resolver;
};

/**
 * Resolve a trusted, enabled issuer row by exact `iss` match. Returns
 * undefined when the issuer is absent or disabled, which the caller maps
 * to `issuer_not_enabled` (default deny). The allow-list ships empty, so
 * this returns undefined for every issuer until an operator trusts one.
 */
export const findTrustedIssuer = async (
  issuer: string,
): Promise<TrustedIssuerRow | undefined> => {
  const rows = await rootDb
    .select({
      issuer: agentTrustedIssuer.issuer,
      enabled: agentTrustedIssuer.enabled,
      attestationPolicy: agentTrustedIssuer.attestationPolicy,
    })
    .from(agentTrustedIssuer)
    .where(
      and(
        eq(agentTrustedIssuer.issuer, issuer),
        eq(agentTrustedIssuer.enabled, true),
      ),
    )
    .limit(1);
  return rows.at(0);
};

const isHttpsUrl = (value: string): boolean => {
  const parsed = Result.try(() => new URL(value));
  return Result.isOk(parsed) && parsed.value.protocol === "https:";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Read the unverified header `iss`. We must know the issuer before we can
 * pick a JWKS, but the value is only trusted once the signature verifies
 * against that issuer's keys AND the verified `iss` claim equals it.
 */
const readUnverifiedIssuer = (assertion: string): string | undefined => {
  const segment = assertion.split(".").at(1);
  if (!segment) {
    return undefined;
  }
  const decoded = Result.try((): unknown =>
    JSON.parse(Buffer.from(segment, "base64url").toString()),
  );
  if (Result.isError(decoded) || !isRecord(decoded.value)) {
    return undefined;
  }
  const iss = decoded.value["iss"];
  return typeof iss === "string" ? iss : undefined;
};

const requiredAmrSatisfied = (
  attestationPolicy: unknown,
  payload: JWTPayload,
): boolean => {
  if (!isRecord(attestationPolicy)) {
    return true;
  }
  const required = attestationPolicy["requiredAmr"];
  if (!Array.isArray(required) || required.length === 0) {
    return true;
  }
  const amr = payload["amr"];
  const presented = Array.isArray(amr)
    ? amr.filter((entry): entry is string => typeof entry === "string")
    : [];
  return required.every(
    (entry) => typeof entry === "string" && presented.includes(entry),
  );
};

const isVerifiedIdentity = (payload: JWTPayload): boolean =>
  payload["email_verified"] === true ||
  payload["phone_number_verified"] === true;

/**
 * Validate an inbound ID-JAG end to end: trusted-issuer allow-list, JWKS
 * signature (asymmetric algs only, `typ` checked), audience, freshness,
 * verified identity, optional per-issuer attestation, and a one-time jti
 * replay check. Returns the trusted facts on success.
 */
export const validateIdJag = async (
  assertion: string,
): Promise<Result<ValidatedIdJag, IdJagValidationError>> => {
  const unverifiedIssuer = readUnverifiedIssuer(assertion);
  if (!unverifiedIssuer || !isHttpsUrl(unverifiedIssuer)) {
    return Result.err(
      new IdJagValidationError("issuer_not_enabled", "Unknown issuer."),
    );
  }

  const trusted = await findTrustedIssuer(unverifiedIssuer);
  if (!trusted) {
    return Result.err(
      new IdJagValidationError(
        "issuer_not_enabled",
        "Issuer is not on the trusted allow-list.",
      ),
    );
  }

  const verifyResult = await Result.tryPromise(
    async () =>
      await jwtVerify(assertion, getJwksFor(trusted.issuer), {
        issuer: trusted.issuer,
        audience: getAuthIssuerUrl(),
        algorithms: [...AGENT_AUTH_ID_JAG_ALLOWED_ALGS],
        typ: AGENT_AUTH_ID_JAG_JWT_TYP,
        clockTolerance: AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS,
        // jose enforces presence + value for iss/aud/typ and presence for
        // these required claims; the per-claim checks below add the
        // verified-identity and freshness rules jose cannot express.
        requiredClaims: ["sub", "jti", "exp", "iat", "auth_time", "email"],
      }),
  );
  if (Result.isError(verifyResult)) {
    return Result.err(
      new IdJagValidationError(
        "invalid_assertion",
        "Assertion signature or claims did not verify.",
      ),
    );
  }

  const { payload } = verifyResult.value;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const sub = payload.sub;
  const jti = payload.jti;
  const email = payload["email"];
  const authTime = payload["auth_time"];
  const iat = payload.iat;
  const exp = payload.exp;

  if (typeof sub !== "string" || sub.length === 0) {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "Missing sub."),
    );
  }
  if (typeof jti !== "string" || jti.length === 0) {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "Missing jti."),
    );
  }
  if (typeof email !== "string" || email.length === 0) {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "Missing email."),
    );
  }
  if (typeof exp !== "number") {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "Missing exp."),
    );
  }
  // `iat` must not be unreasonably in the future (jwtVerify does not gate
  // a future iat on its own).
  if (
    typeof iat === "number" &&
    iat > nowSeconds + AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS
  ) {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "iat is in the future."),
    );
  }

  if (typeof payload["client_id"] !== "string") {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "Missing client_id."),
    );
  }

  if (!isVerifiedIdentity(payload)) {
    return Result.err(
      new IdJagValidationError(
        "invalid_assertion",
        "Identity is not verified.",
      ),
    );
  }

  // auth_time freshness: present and within the max auth age, else the
  // human must re-authenticate at the issuer (login_required).
  if (typeof authTime !== "number") {
    return Result.err(
      new IdJagValidationError("login_required", "Missing auth_time."),
    );
  }
  if (authTime > nowSeconds + AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS) {
    return Result.err(
      new IdJagValidationError(
        "invalid_assertion",
        "auth_time is in the future.",
      ),
    );
  }
  if (nowSeconds - authTime > AGENT_AUTH_ID_JAG_MAX_AUTH_AGE_SECONDS) {
    return Result.err(
      new IdJagValidationError(
        "login_required",
        "Upstream authentication is too old.",
      ),
    );
  }

  if (!requiredAmrSatisfied(trusted.attestationPolicy, payload)) {
    return Result.err(
      new IdJagValidationError(
        "invalid_assertion",
        "Issuer attestation policy not satisfied.",
      ),
    );
  }

  const expiresAt = new Date(exp * 1000);
  const replayResult = await recordJti(jti, expiresAt);
  if (Result.isError(replayResult)) {
    return Result.err(
      new IdJagValidationError("invalid_assertion", "Assertion was replayed."),
    );
  }

  return Result.ok({ iss: trusted.issuer, sub, email, jti, expiresAt });
};

class ReplayError {}

/**
 * Insert the jti one-time, failing closed on a duplicate (the unique PK
 * makes a second insert of the same jti a conflict).
 *
 * TODO: prune rows whose assertion has expired from a periodic background
 * job rather than on this read-heavy validation path; `expires_at` is
 * indexed for exactly that sweep.
 */
const recordJti = async (
  jti: string,
  expiresAt: Date,
): Promise<Result<void, ReplayError>> => {
  const inserted = await Result.tryPromise(
    async () =>
      await rootDb
        .insert(agentAssertionReplay)
        .values({ jti, expiresAt })
        .onConflictDoNothing()
        .returning({ jti: agentAssertionReplay.jti }),
  );
  if (Result.isError(inserted)) {
    return Result.err(new ReplayError());
  }
  if (inserted.value.length === 0) {
    return Result.err(new ReplayError());
  }
  return Result.ok(undefined);
};
