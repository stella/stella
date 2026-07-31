import { Result } from "better-result";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { X509Certificate } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import { account, ssoProvider, verification } from "@/api/db/auth-schema";
import type { SsoEnforcementMode, SsoProtocol } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  revokeOrganizationNonSsoSessions,
  revokeSsoProviderSessions,
} from "@/api/lib/auth-artifacts";
import { AUTH_API_PATH } from "@/api/lib/auth-paths";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  safeOutboundFetchBytes,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

const DOMAIN_VERIFICATION_TOKEN_PREFIX = "stella-sso";
const DOMAIN_VERIFICATION_TTL_MS = 7 * DAY_IN_MS;
const DISCOVERY_DOCUMENT_MAX_BYTES = 128 * 1024;
const DISCOVERY_TIMEOUT_MS = 8000;
const SAML_CERTIFICATE_MAX_CHARS = 50_000;
const SSO_SCOPES = ["openid", "email", "profile"] as const;

const oidcDiscoverySchema = v.strictObject({
  issuer: v.pipe(v.string(), v.url()),
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  jwks_uri: v.pipe(v.string(), v.url()),
  userinfo_endpoint: v.optional(v.pipe(v.string(), v.url())),
  token_endpoint_auth_methods_supported: v.optional(v.array(v.string())),
});

type OidcConnectionInput = {
  protocol: "oidc";
  domain: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
};

type SamlConnectionInput = {
  protocol: "saml";
  domain: string;
  issuer: string;
  entryPoint: string;
  certificate: string;
};

export type CreateSsoConnectionInput =
  | OidcConnectionInput
  | SamlConnectionInput;

type SsoConnectionRow = {
  id: string;
  providerId: string;
  protocol: SsoProtocol;
  issuer: string;
  domain: string;
  domainVerified: boolean;
  enforcementMode: SsoEnforcementMode;
  createdAt: Date;
  updatedAt: Date;
};

const authBaseUrl = `${env.BETTER_AUTH_URL.replace(/\/$/u, "")}${AUTH_API_PATH}`;

const connectionUrls = (providerId: string, protocol: SsoProtocol) => ({
  callbackUrl:
    protocol === "oidc"
      ? `${authBaseUrl}/sso/callback/${encodeURIComponent(providerId)}`
      : `${authBaseUrl}/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`,
  metadataUrl:
    protocol === "saml"
      ? `${authBaseUrl}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`
      : null,
});

const verificationIdentifier = (providerId: string): string =>
  `_${DOMAIN_VERIFICATION_TOKEN_PREFIX}-${providerId}`;

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

export const normalizeSsoDomain = (
  rawDomain: string,
): Result<string, HandlerError> => {
  const normalized = domainToASCII(
    rawDomain.trim().toLowerCase().replace(/\.$/u, ""),
  );
  const labels = normalized.split(".");
  const topLevelDomain = labels.at(-1) ?? "";
  const valid =
    normalized.length >= 3 &&
    normalized.length <= 253 &&
    isIP(normalized) === 0 &&
    labels.length >= 2 &&
    /[a-z]/u.test(topLevelDomain) &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );

  if (!valid) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid SSO email domain" }),
    );
  }

  return Result.ok(normalized);
};

const validatePublicHttpsUrl = async (
  rawUrl: string,
  fieldName: string,
): Promise<Result<string, HandlerError>> => {
  const parsedResult = Result.try({
    try: () => new URL(rawUrl),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: `${fieldName} must be a valid URL`,
        cause,
      }),
  });
  if (Result.isError(parsedResult)) {
    return Result.err(parsedResult.error);
  }
  const parsed = parsedResult.value;

  if (parsed.protocol !== "https:") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `${fieldName} must use HTTPS`,
      }),
    );
  }

  const target = await validateOutboundFetchTarget(parsed);
  if (Result.isError(target)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `${fieldName} must use a public network address`,
        cause: target.error,
      }),
    );
  }

  return Result.ok(parsed.toString());
};

const discoverOidcConfig = async ({
  issuer,
  clientId,
  clientSecret,
}: Omit<OidcConnectionInput, "protocol" | "domain">) => {
  const issuerResult = await validatePublicHttpsUrl(issuer, "OIDC issuer");
  if (Result.isError(issuerResult)) {
    return Result.err(issuerResult.error);
  }

  const normalizedIssuer = trimTrailingSlash(issuerResult.value);
  const discoveryEndpoint = `${normalizedIssuer}/.well-known/openid-configuration`;
  const response = await safeOutboundFetchBytes({
    url: discoveryEndpoint,
    maxBytes: DISCOVERY_DOCUMENT_MAX_BYTES,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    redirect: "error",
  });
  if (Result.isError(response) || !response.value.ok) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "OIDC discovery failed",
        ...(Result.isError(response) ? { cause: response.error } : {}),
      }),
    );
  }

  const decoded = new TextDecoder().decode(response.value.body);
  const parsedJson = Result.try({
    try: (): unknown => JSON.parse(decoded),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "OIDC discovery returned invalid JSON",
        cause,
      }),
  });
  if (Result.isError(parsedJson)) {
    return Result.err(parsedJson.error);
  }

  const discovery = v.safeParse(oidcDiscoverySchema, parsedJson.value);
  if (!discovery.success) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "OIDC discovery document is incomplete",
      }),
    );
  }
  if (trimTrailingSlash(discovery.output.issuer) !== normalizedIssuer) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "OIDC discovery issuer does not match the configured issuer",
      }),
    );
  }

  const endpointResults = await Promise.all(
    [
      [discovery.output.authorization_endpoint, "OIDC authorization endpoint"],
      [discovery.output.token_endpoint, "OIDC token endpoint"],
      [discovery.output.jwks_uri, "OIDC JWKS endpoint"],
      ...(discovery.output.userinfo_endpoint
        ? [[discovery.output.userinfo_endpoint, "OIDC user-info endpoint"]]
        : []),
    ].map(
      async ([url, label]) =>
        await validatePublicHttpsUrl(url ?? "", label ?? "OIDC endpoint"),
    ),
  );
  const unsafeEndpoint = endpointResults.find(Result.isError);
  if (unsafeEndpoint && Result.isError(unsafeEndpoint)) {
    return Result.err(unsafeEndpoint.error);
  }

  const supportedMethods =
    discovery.output.token_endpoint_auth_methods_supported;
  let tokenEndpointAuthentication:
    | "client_secret_basic"
    | "client_secret_post"
    | null = null;
  if (
    supportedMethods === undefined ||
    supportedMethods.includes("client_secret_basic")
  ) {
    tokenEndpointAuthentication = "client_secret_basic";
  } else if (supportedMethods.includes("client_secret_post")) {
    tokenEndpointAuthentication = "client_secret_post";
  }
  if (!tokenEndpointAuthentication) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "OIDC provider does not support a compatible client authentication method",
      }),
    );
  }

  return Result.ok({
    issuer: normalizedIssuer,
    clientId,
    clientSecret,
    discoveryEndpoint,
    authorizationEndpoint: discovery.output.authorization_endpoint,
    tokenEndpoint: discovery.output.token_endpoint,
    jwksEndpoint: discovery.output.jwks_uri,
    userInfoEndpoint: discovery.output.userinfo_endpoint,
    tokenEndpointAuthentication,
    pkce: true,
    scopes: [...SSO_SCOPES],
  });
};

const buildSamlConfig = async (
  input: Omit<SamlConnectionInput, "protocol" | "domain">,
  providerId: string,
) => {
  const issuerResult = Result.try({
    try: () => new URL(input.issuer.trim()).toString(),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "SAML entity ID must be a valid URI",
        cause,
      }),
  });
  if (Result.isError(issuerResult)) {
    return Result.err(issuerResult.error);
  }
  const entryPointResult = await validatePublicHttpsUrl(
    input.entryPoint,
    "SAML sign-in URL",
  );
  if (Result.isError(entryPointResult)) {
    return Result.err(entryPointResult.error);
  }

  const certificate = input.certificate.trim();
  if (
    certificate.length > SAML_CERTIFICATE_MAX_CHARS ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/u.test(
      certificate,
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "SAML signing certificate must be a PEM certificate",
      }),
    );
  }
  const parsedCertificate = Result.try({
    try: () => new X509Certificate(certificate),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "SAML signing certificate is invalid",
        cause,
      }),
  });
  if (Result.isError(parsedCertificate)) {
    return Result.err(parsedCertificate.error);
  }
  const now = Date.now();
  if (
    new Date(parsedCertificate.value.validFrom).getTime() > now ||
    new Date(parsedCertificate.value.validTo).getTime() <= now
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "SAML signing certificate is not currently valid",
      }),
    );
  }

  const { callbackUrl, metadataUrl } = connectionUrls(providerId, "saml");
  if (!metadataUrl) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "SAML metadata URL is unavailable",
      }),
    );
  }
  const spEntityId = metadataUrl;

  return Result.ok({
    issuer: spEntityId,
    entryPoint: entryPointResult.value,
    cert: certificate,
    callbackUrl,
    audience: spEntityId,
    idpMetadata: {
      entityID: issuerResult.value,
      cert: certificate,
      singleSignOnService: [
        {
          Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
          Location: entryPointResult.value,
        },
      ],
    },
    spMetadata: { entityID: spEntityId },
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
  });
};

const selectConnection = async (
  organizationId: SafeId<"organization">,
): Promise<SsoConnectionRow | null> =>
  (await rootDb.query.ssoProvider.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: {
      id: true,
      providerId: true,
      protocol: true,
      issuer: true,
      domain: true,
      domainVerified: true,
      enforcementMode: true,
      createdAt: true,
      updatedAt: true,
    },
  })) ?? null;

const pendingVerification = async (providerId: string) =>
  await rootDb
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, verificationIdentifier(providerId)),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));

const toConnectionResponse = async (row: SsoConnectionRow) => {
  const verificationRecord = row.domainVerified
    ? null
    : await pendingVerification(row.providerId);
  const identifier = verificationIdentifier(row.providerId);

  return {
    ...row,
    ...connectionUrls(row.providerId, row.protocol),
    dnsVerification: verificationRecord
      ? {
          name: `${identifier}.${row.domain}`,
          value: `${identifier}=${verificationRecord.value}`,
          expiresAt: verificationRecord.expiresAt,
        }
      : null,
  };
};

export type SsoConnectionResponse = Awaited<
  ReturnType<typeof toConnectionResponse>
>;

export const readSsoConnection = async (
  organizationId: SafeId<"organization">,
): Promise<Result<SsoConnectionResponse | null, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const row = await selectConnection(organizationId);
      return row ? await toConnectionResponse(row) : null;
    },
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not read SSO connection",
        cause,
      }),
  });

export const createSsoConnection = async ({
  organizationId,
  userId,
  input,
  recordAuditEvent,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  input: CreateSsoConnectionInput;
  recordAuditEvent: AuditRecorder;
}): Promise<Result<SsoConnectionResponse, HandlerError>> => {
  const domainResult = normalizeSsoDomain(input.domain);
  if (Result.isError(domainResult)) {
    return Result.err(domainResult.error);
  }

  const id = createSafeId<"ssoConnection">();
  const providerId = `sso-${id}`;
  let oidcConfig: string | null = null;
  let samlConfig: string | null = null;
  if (input.protocol === "oidc") {
    const configResult = await discoverOidcConfig(input);
    if (Result.isError(configResult)) {
      return Result.err(configResult.error);
    }
    oidcConfig = JSON.stringify(configResult.value);
  } else {
    const configResult = await buildSamlConfig(input, providerId);
    if (Result.isError(configResult)) {
      return Result.err(configResult.error);
    }
    samlConfig = JSON.stringify(configResult.value);
  }

  const inserted = await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        const rows = await tx
          .insert(ssoProvider)
          .values({
            id,
            providerId,
            protocol: input.protocol,
            issuer: trimTrailingSlash(input.issuer),
            domain: domainResult.value,
            userId,
            organizationId,
            oidcConfig,
            samlConfig,
          })
          .onConflictDoNothing()
          .returning({ id: ssoProvider.id });

        if (!rows.at(0)) {
          throw new HandlerError({
            status: 409,
            message:
              "This organization or domain already has an SSO connection",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.SSO_CONNECTION,
          resourceId: providerId,
          metadata: { protocol: input.protocol, domain: domainResult.value },
        });
      }),
    catch: (cause) =>
      cause instanceof HandlerError
        ? cause
        : new HandlerError({
            status: 500,
            message: "Could not create SSO connection",
            cause,
          }),
  });
  if (Result.isError(inserted)) {
    return Result.err(inserted.error);
  }

  const row = await selectConnection(organizationId);
  if (!row) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "SSO connection was not created",
      }),
    );
  }
  return Result.ok(await toConnectionResponse(row));
};

export const requestSsoDomainVerification = async ({
  organizationId,
  recordAuditEvent,
}: {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
}): Promise<Result<SsoConnectionResponse, HandlerError>> => {
  const connection = await selectConnection(organizationId);
  if (!connection) {
    return Result.err(
      new HandlerError({ status: 404, message: "SSO connection not found" }),
    );
  }
  if (connection.domainVerified) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "SSO domain is already verified",
      }),
    );
  }

  const identifier = verificationIdentifier(connection.providerId);
  const requested = await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${identifier}))`,
        );
        const liveConnection = await tx
          .select({ domainVerified: ssoProvider.domainVerified })
          .from(ssoProvider)
          .where(
            and(
              eq(ssoProvider.organizationId, organizationId),
              eq(ssoProvider.providerId, connection.providerId),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows.at(0));
        if (!liveConnection) {
          throw new HandlerError({
            status: 404,
            message: "SSO connection not found",
          });
        }
        if (liveConnection.domainVerified) {
          throw new HandlerError({
            status: 409,
            message: "SSO domain is already verified",
          });
        }

        const existing = await tx
          .select({ id: verification.id })
          .from(verification)
          .where(
            and(
              eq(verification.identifier, identifier),
              gt(verification.expiresAt, new Date()),
            ),
          )
          .limit(1)
          .then((rows) => rows.at(0));
        if (existing) {
          return;
        }

        await tx
          .delete(verification)
          .where(
            and(
              eq(verification.identifier, identifier),
              lt(verification.expiresAt, new Date()),
            ),
          );
        const token = crypto.getRandomValues(new Uint8Array(24));
        const value = Buffer.from(token).toString("base64url");
        const expiresAt = new Date(Date.now() + DOMAIN_VERIFICATION_TTL_MS);
        await tx.insert(verification).values({
          id: createSafeId<"ssoConnection">(),
          identifier,
          value,
          expiresAt,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SSO_CONNECTION,
          resourceId: connection.providerId,
          metadata: { event: "domain_verification_requested" },
        });
      }),
    catch: (cause) =>
      cause instanceof HandlerError
        ? cause
        : new HandlerError({
            status: 500,
            message: "Could not request SSO domain verification",
            cause,
          }),
  });
  if (Result.isError(requested)) {
    return Result.err(requested.error);
  }

  const row = await selectConnection(organizationId);
  if (!row) {
    return Result.err(
      new HandlerError({ status: 404, message: "SSO connection not found" }),
    );
  }
  return Result.ok(await toConnectionResponse(row));
};

export const verifySsoDomain = async ({
  organizationId,
  recordAuditEvent,
}: {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
}): Promise<Result<SsoConnectionResponse, HandlerError>> => {
  const connection = await selectConnection(organizationId);
  if (!connection) {
    return Result.err(
      new HandlerError({ status: 404, message: "SSO connection not found" }),
    );
  }
  if (connection.domainVerified) {
    return Result.ok(await toConnectionResponse(connection));
  }

  const identifier = verificationIdentifier(connection.providerId);
  const pending = await pendingVerification(connection.providerId);
  if (!pending) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Request a DNS verification record first",
      }),
    );
  }

  const recordsResult = await Result.tryPromise({
    try: async () => await resolveTxt(`${identifier}.${connection.domain}`),
    catch: (cause) =>
      new HandlerError({
        status: 502,
        message: "DNS verification record was not found",
        cause,
      }),
  });
  if (Result.isError(recordsResult)) {
    return Result.err(recordsResult.error);
  }
  const expectedValues = new Set([
    pending.value,
    `${identifier}=${pending.value}`,
  ]);
  const verified = recordsResult.value.some((parts) =>
    expectedValues.has(parts.join("").trim()),
  );
  if (!verified) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "DNS verification record does not match",
      }),
    );
  }

  const persisted = await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        const liveConnection = await tx
          .select({ domainVerified: ssoProvider.domainVerified })
          .from(ssoProvider)
          .where(
            and(
              eq(ssoProvider.organizationId, organizationId),
              eq(ssoProvider.providerId, connection.providerId),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows.at(0));
        if (!liveConnection) {
          throw new HandlerError({
            status: 404,
            message: "SSO connection not found",
          });
        }
        if (liveConnection.domainVerified) {
          return;
        }

        await tx
          .update(ssoProvider)
          .set({ domainVerified: true, updatedAt: new Date() })
          .where(
            and(
              eq(ssoProvider.organizationId, organizationId),
              eq(ssoProvider.providerId, connection.providerId),
              eq(ssoProvider.domainVerified, false),
            ),
          );
        await tx
          .delete(verification)
          .where(eq(verification.identifier, identifier));
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SSO_CONNECTION,
          resourceId: connection.providerId,
          changes: { domainVerified: { old: false, new: true } },
        });
      }),
    catch: (cause) =>
      cause instanceof HandlerError
        ? cause
        : new HandlerError({
            status: 500,
            message: "Could not verify SSO domain",
            cause,
          }),
  });
  if (Result.isError(persisted)) {
    return Result.err(persisted.error);
  }

  const row = await selectConnection(organizationId);
  if (!row) {
    return Result.err(
      new HandlerError({ status: 404, message: "SSO connection not found" }),
    );
  }
  return Result.ok(await toConnectionResponse(row));
};

export const setSsoEnforcement = async ({
  organizationId,
  mode,
  currentSessionSsoProviderId,
  recordAuditEvent,
}: {
  organizationId: SafeId<"organization">;
  mode: SsoEnforcementMode;
  currentSessionSsoProviderId: string | null;
  recordAuditEvent: AuditRecorder;
}): Promise<Result<SsoConnectionResponse, HandlerError>> => {
  const result = await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        const connection = await tx
          .select({
            providerId: ssoProvider.providerId,
            domainVerified: ssoProvider.domainVerified,
            enforcementMode: ssoProvider.enforcementMode,
          })
          .from(ssoProvider)
          .where(eq(ssoProvider.organizationId, organizationId))
          .limit(1)
          .for("update")
          .then((rows) => rows.at(0));
        if (!connection) {
          throw new HandlerError({
            status: 404,
            message: "SSO connection not found",
          });
        }
        if (mode === "required" && !connection.domainVerified) {
          throw new HandlerError({
            status: 409,
            message: "Verify the SSO domain before requiring SSO",
          });
        }
        if (
          mode === "required" &&
          currentSessionSsoProviderId !== connection.providerId
        ) {
          throw new HandlerError({
            code: "sso_reauthentication_required",
            status: 409,
            message: "Sign in through this SSO connection before requiring it",
          });
        }

        await tx
          .update(ssoProvider)
          .set({ enforcementMode: mode, updatedAt: new Date() })
          .where(eq(ssoProvider.organizationId, organizationId));

        if (mode === "required") {
          await revokeOrganizationNonSsoSessions(tx, {
            organizationId,
            providerId: connection.providerId,
          });
        }

        if (connection.enforcementMode !== mode) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.SSO_CONNECTION,
            resourceId: connection.providerId,
            changes: {
              enforcementMode: { old: connection.enforcementMode, new: mode },
            },
          });
        }
      }),
    catch: (cause) =>
      cause instanceof HandlerError
        ? cause
        : new HandlerError({
            status: 500,
            message: "Could not update SSO enforcement",
            cause,
          }),
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }

  const row = await selectConnection(organizationId);
  if (!row) {
    return Result.err(
      new HandlerError({ status: 404, message: "SSO connection not found" }),
    );
  }
  return Result.ok(await toConnectionResponse(row));
};

export const deleteSsoConnection = async ({
  organizationId,
  recordAuditEvent,
}: {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
}): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        const connection = await tx
          .select({
            providerId: ssoProvider.providerId,
            enforcementMode: ssoProvider.enforcementMode,
          })
          .from(ssoProvider)
          .where(eq(ssoProvider.organizationId, organizationId))
          .limit(1)
          .for("update")
          .then((rows) => rows.at(0));
        if (!connection) {
          throw new HandlerError({
            status: 404,
            message: "SSO connection not found",
          });
        }
        if (connection.enforcementMode === "required") {
          throw new HandlerError({
            status: 409,
            message: "Make SSO optional before deleting the connection",
          });
        }

        await tx
          .delete(account)
          .where(eq(account.providerId, connection.providerId));
        await revokeSsoProviderSessions(tx, connection.providerId);
        await tx
          .delete(verification)
          .where(
            eq(
              verification.identifier,
              verificationIdentifier(connection.providerId),
            ),
          );
        await tx
          .delete(ssoProvider)
          .where(
            and(
              eq(ssoProvider.organizationId, organizationId),
              eq(ssoProvider.providerId, connection.providerId),
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.SSO_CONNECTION,
          resourceId: connection.providerId,
        });
      }),
    catch: (cause) =>
      cause instanceof HandlerError
        ? cause
        : new HandlerError({
            status: 500,
            message: "Could not delete SSO connection",
            cause,
          }),
  });
