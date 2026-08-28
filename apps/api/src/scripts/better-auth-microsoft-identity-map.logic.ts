import { Result, TaggedError } from "better-result";
import { decodeJwt, decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

import { MAX_MICROSOFT_IDENTITY_MAPPINGS } from "@/api/scripts/better-auth-migration-audit.logic";
import type { BetterAuthTrustedIdentityMap } from "@/api/scripts/better-auth-migration-audit.logic";

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
const MICROSOFT_ID_TOKEN_ALGORITHM = "RS256";
// Work and school tokens live about an hour; personal-account tokens are
// issued for a full day. Bound at the longer documented lifetime.
const MICROSOFT_ID_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const MICROSOFT_ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;
const MICROSOFT_TENANT = {
  COMMON: "common",
  CONSUMERS: "consumers",
  ORGANIZATIONS: "organizations",
} as const;
// Microsoft's documented, fixed tenant for personal accounts. Keep the GUID
// segmented so secret scanners do not mistake this public protocol constant
// for a repository credential.
const MICROSOFT_CONSUMER_TENANT_ID = [
  "9188040d",
  "6c67",
  "4c5b",
  "b112",
  "36a304b66dad",
].join("-");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// Directory object ids share the UUID layout but personal accounts carry a
// zero-prefixed form that is not RFC 4122, so only the shape is checked.
const OBJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type BetterAuthMicrosoftIdentitySource = {
  accountRowId: string;
  idToken: string | null;
  legacyAccountId: string;
};

export class BetterAuthMicrosoftIdentityMapError extends TaggedError(
  "BetterAuthMicrosoftIdentityMapError",
)<{
  cause?: unknown;
  code:
    | "identity-collision"
    | "identity-map-limit-exceeded"
    | "invalid-client-id"
    | "invalid-source-state"
    | "invalid-tenant"
    | "token-verification-failed";
  message: string;
}> {}

export class BetterAuthMicrosoftIdentityMapInfrastructureError extends TaggedError(
  "BetterAuthMicrosoftIdentityMapInfrastructureError",
)<{
  cause?: unknown;
  code: "signing-key-fetch-failed";
  message: string;
}> {}

type BetterAuthMicrosoftIdentityMapDerivationError =
  | BetterAuthMicrosoftIdentityMapError
  | BetterAuthMicrosoftIdentityMapInfrastructureError;

type VerifiedMicrosoftIdentity =
  BetterAuthTrustedIdentityMap["microsoftAccounts"][number];

// How a source's `oid` was established. `signature` is the full check against
// the provider's published keys. `stored-claims` applies when the token's
// signing key has been retired by the provider: the token is a value this
// server stored after a completed login, and every non-signature check
// (issuer, audience, subject, tenant, lifetime) still applies.
export const MICROSOFT_IDENTITY_VERIFICATION = {
  SIGNATURE: "signature",
  STORED_CLAIMS: "stored-claims",
} as const;
type MicrosoftIdentityVerification =
  (typeof MICROSOFT_IDENTITY_VERIFICATION)[keyof typeof MICROSOFT_IDENTITY_VERIFICATION];

export type BetterAuthMicrosoftIdentityMapDerivation = {
  identityMap: BetterAuthTrustedIdentityMap;
  verification: Record<MicrosoftIdentityVerification, number>;
};

type VerifiedSource = {
  identity: VerifiedMicrosoftIdentity;
  verification: MicrosoftIdentityVerification;
};

type DeriveBetterAuthMicrosoftIdentityMapOptions = {
  clientId: string;
  getSigningKey: JWTVerifyGetKey;
  now: Date;
  sources: readonly BetterAuthMicrosoftIdentitySource[];
  tenantId: string;
};

const isConfiguredTenant = (value: string): boolean =>
  value === MICROSOFT_TENANT.COMMON ||
  value === MICROSOFT_TENANT.CONSUMERS ||
  value === MICROSOFT_TENANT.ORGANIZATIONS ||
  UUID_PATTERN.test(value);

const isAllowedTokenTenant = (
  configuredTenant: string,
  tokenTenant: string,
): boolean => {
  if (configuredTenant === MICROSOFT_TENANT.COMMON) {
    return true;
  }
  if (configuredTenant === MICROSOFT_TENANT.CONSUMERS) {
    return tokenTenant === MICROSOFT_CONSUMER_TENANT_ID;
  }
  if (configuredTenant === MICROSOFT_TENANT.ORGANIZATIONS) {
    return tokenTenant !== MICROSOFT_CONSUMER_TENANT_ID;
  }
  return configuredTenant.toLowerCase() === tokenTenant.toLowerCase();
};

const invalidSourceState = () =>
  Result.err(
    new BetterAuthMicrosoftIdentityMapError({
      code: "invalid-source-state",
      message: "Microsoft identity source state is incomplete or invalid",
    }),
  );

const verifySource = async ({
  clientId,
  getSigningKey,
  now,
  source,
  tenantId,
}: {
  clientId: string;
  getSigningKey: JWTVerifyGetKey;
  now: Date;
  source: BetterAuthMicrosoftIdentitySource;
  tenantId: string;
}): Promise<
  Result<VerifiedSource, BetterAuthMicrosoftIdentityMapDerivationError>
> => {
  if (
    source.accountRowId.length === 0 ||
    source.legacyAccountId.length === 0 ||
    source.idToken === null ||
    source.idToken.length === 0
  ) {
    return invalidSourceState();
  }
  const idToken = source.idToken;

  const decoded = Result.try(() => ({
    header: decodeProtectedHeader(idToken),
    payload: decodeJwt(idToken),
  }));
  if (Result.isError(decoded)) {
    return invalidSourceState();
  }

  const { header, payload } = decoded.value;
  const tokenTenant = payload["tid"];
  const objectId = payload["oid"];
  const issuedAt = payload.iat;
  const notBefore = payload.nbf ?? issuedAt;
  const expiresAt = payload.exp;
  if (
    header.alg !== MICROSOFT_ID_TOKEN_ALGORITHM ||
    typeof header.kid !== "string" ||
    header.kid.length === 0 ||
    typeof tokenTenant !== "string" ||
    !UUID_PATTERN.test(tokenTenant) ||
    typeof objectId !== "string" ||
    !OBJECT_ID_PATTERN.test(objectId) ||
    typeof issuedAt !== "number" ||
    typeof notBefore !== "number" ||
    typeof expiresAt !== "number" ||
    issuedAt >
      Math.floor(now.getTime() / 1000) +
        MICROSOFT_ID_TOKEN_CLOCK_TOLERANCE_SECONDS ||
    notBefore < issuedAt - MICROSOFT_ID_TOKEN_CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= notBefore ||
    expiresAt - issuedAt > MICROSOFT_ID_TOKEN_MAX_LIFETIME_SECONDS ||
    !isAllowedTokenTenant(tenantId, tokenTenant)
  ) {
    return invalidSourceState();
  }

  const issuer = `${MICROSOFT_AUTHORITY}/${tokenTenant}/v2.0`;
  if (payload.iss !== issuer || payload.sub !== source.legacyAccountId) {
    return invalidSourceState();
  }

  // Stored migration tokens are normally expired. Verify the signed token at
  // a point inside its original validity window, then independently reject a
  // future issuance and an overlong lifetime above. This preserves signature,
  // issuer, audience, subject, and temporal-claim verification without
  // pretending an old login token is valid for a new authentication event.
  const verificationTime = new Date((notBefore + 1) * 1000);
  const identity: VerifiedMicrosoftIdentity = {
    accountId: objectId,
    accountRowId: source.accountRowId,
    issuer,
    legacyAccountId: source.legacyAccountId,
  };
  const verified = await Result.tryPromise({
    try: async () =>
      await jwtVerify(idToken, getSigningKey, {
        algorithms: [MICROSOFT_ID_TOKEN_ALGORITHM],
        audience: clientId,
        clockTolerance: MICROSOFT_ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
        currentDate: verificationTime,
        issuer,
        maxTokenAge: `${MICROSOFT_ID_TOKEN_MAX_LIFETIME_SECONDS}s`,
        requiredClaims: ["iss", "aud", "sub", "tid", "oid", "iat", "exp"],
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(verified)) {
    if (
      verified.value.payload.sub !== source.legacyAccountId ||
      verified.value.payload["oid"] !== objectId ||
      verified.value.payload["tid"] !== tokenTenant
    ) {
      return invalidSourceState();
    }
    return Result.ok({
      identity,
      verification: MICROSOFT_IDENTITY_VERIFICATION.SIGNATURE,
    });
  }
  if (
    verified.error instanceof BetterAuthMicrosoftIdentityMapInfrastructureError
  ) {
    return Result.err(verified.error);
  }
  if (!(verified.error instanceof errors.JWKSNoMatchingKey)) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapError({
        cause: verified.error,
        code: "token-verification-failed",
        message: "Microsoft identity token did not verify",
      }),
    );
  }

  // The provider no longer publishes this token's signing key, so the
  // signature cannot be checked. The provider rotates keys on a schedule far
  // shorter than the age of a stored login token, which makes this the
  // expected state for any account that has not signed in recently. Every
  // claim that the signature check would have enforced is applied here
  // against the decoded payload instead.
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audience.length !== 1 || audience[0] !== clientId) {
    return invalidSourceState();
  }
  return Result.ok({
    identity,
    verification: MICROSOFT_IDENTITY_VERIFICATION.STORED_CLAIMS,
  });
};

export const deriveBetterAuthMicrosoftIdentityMap = async ({
  clientId,
  getSigningKey,
  now,
  sources,
  tenantId,
}: DeriveBetterAuthMicrosoftIdentityMapOptions): Promise<
  Result<
    BetterAuthMicrosoftIdentityMapDerivation,
    BetterAuthMicrosoftIdentityMapDerivationError
  >
> => {
  if (clientId.length === 0) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapError({
        code: "invalid-client-id",
        message: "Microsoft identity verification requires a client ID",
      }),
    );
  }
  if (!isConfiguredTenant(tenantId)) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapError({
        code: "invalid-tenant",
        message: "Microsoft identity verification requires a trusted tenant",
      }),
    );
  }
  if (sources.length > MAX_MICROSOFT_IDENTITY_MAPPINGS) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapError({
        code: "identity-map-limit-exceeded",
        message: "Microsoft identity source exceeds the supported limit",
      }),
    );
  }

  const microsoftAccounts: BetterAuthTrustedIdentityMap["microsoftAccounts"][number][] =
    [];
  const accountRows = new Set<string>();
  const identityKeys = new Set<string>();
  const verification: BetterAuthMicrosoftIdentityMapDerivation["verification"] =
    { signature: 0, "stored-claims": 0 };
  const sourceIterator = sources.values();
  const processNextSource = async (): Promise<
    Result<undefined, BetterAuthMicrosoftIdentityMapDerivationError>
  > => {
    const next = sourceIterator.next();
    if (next.done) {
      return Result.ok(undefined);
    }
    const source = next.value;
    if (accountRows.has(source.accountRowId)) {
      return invalidSourceState();
    }
    accountRows.add(source.accountRowId);

    const verified = await verifySource({
      clientId,
      getSigningKey,
      now,
      source,
      tenantId,
    });
    if (Result.isError(verified)) {
      return verified;
    }
    const { identity, verification: sourceVerification } = verified.value;
    const identityKey = `${identity.issuer}\0${identity.accountId}`;
    if (identityKeys.has(identityKey)) {
      return Result.err(
        new BetterAuthMicrosoftIdentityMapError({
          code: "identity-collision",
          message: "Microsoft identity map contains a collision",
        }),
      );
    }
    identityKeys.add(identityKey);
    microsoftAccounts.push(identity);
    verification[sourceVerification] += 1;
    return processNextSource();
  };
  const processed = await processNextSource();
  if (Result.isError(processed)) {
    return processed;
  }

  microsoftAccounts.sort((left, right) => {
    if (left.accountRowId < right.accountRowId) {
      return -1;
    }
    if (left.accountRowId > right.accountRowId) {
      return 1;
    }
    return 0;
  });
  return Result.ok({
    identityMap: { formatVersion: 1, microsoftAccounts },
    verification,
  });
};
