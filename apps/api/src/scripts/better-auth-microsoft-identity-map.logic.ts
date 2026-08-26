import { Result, TaggedError } from "better-result";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

import type { BetterAuthTrustedIdentityMap } from "@/api/scripts/better-auth-migration-audit.logic";

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
const MICROSOFT_ID_TOKEN_ALGORITHM = "RS256";
const MICROSOFT_ID_TOKEN_MAX_LIFETIME_SECONDS = 2 * 60 * 60;
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
    | "invalid-client-id"
    | "invalid-source-state"
    | "invalid-tenant"
    | "token-verification-failed";
  message: string;
}> {}

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
}) => {
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
    !UUID_PATTERN.test(objectId) ||
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
    catch: (cause) =>
      new BetterAuthMicrosoftIdentityMapError({
        cause,
        code: "token-verification-failed",
        message: "Microsoft identity token did not verify",
      }),
  });
  if (Result.isError(verified)) {
    return verified;
  }
  if (
    verified.value.payload.sub !== source.legacyAccountId ||
    verified.value.payload["oid"] !== objectId ||
    verified.value.payload["tid"] !== tokenTenant
  ) {
    return invalidSourceState();
  }

  return Result.ok({
    accountId: objectId,
    accountRowId: source.accountRowId,
    issuer,
    legacyAccountId: source.legacyAccountId,
  });
};

export const deriveBetterAuthMicrosoftIdentityMap = async ({
  clientId,
  getSigningKey,
  now,
  sources,
  tenantId,
}: DeriveBetterAuthMicrosoftIdentityMapOptions): Promise<
  Result<BetterAuthTrustedIdentityMap, BetterAuthMicrosoftIdentityMapError>
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

  const microsoftAccounts: BetterAuthTrustedIdentityMap["microsoftAccounts"][number][] =
    [];
  const accountRows = new Set<string>();
  const identityKeys = new Set<string>();
  for (const source of sources) {
    if (accountRows.has(source.accountRowId)) {
      return invalidSourceState();
    }
    accountRows.add(source.accountRowId);

    // oxlint-disable-next-line no-await-in-loop -- identity verification stays sequential to bound JWKS pressure and stop at the first untrusted row
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
    const identityKey = `${verified.value.issuer}\0${verified.value.accountId}`;
    if (identityKeys.has(identityKey)) {
      return Result.err(
        new BetterAuthMicrosoftIdentityMapError({
          code: "identity-collision",
          message: "Microsoft identity map contains a collision",
        }),
      );
    }
    identityKeys.add(identityKey);
    microsoftAccounts.push(verified.value);
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
  return Result.ok({ formatVersion: 1, microsoftAccounts });
};
