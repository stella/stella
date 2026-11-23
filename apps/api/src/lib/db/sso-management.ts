import { Result, TaggedError } from "better-result";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import {
  normalizeSsoDomain,
  SSO_DOMAIN_TXT_VALUE_PREFIX,
} from "@stll/api-contract/sso";
import type {
  OrganizationSsoDomainSummary,
  OrganizationSsoPolicyRequirement,
  OrganizationSsoProviderSummary,
  OrganizationSsoSettingsResponse,
  PublicSsoProviderOption,
  SsoProtocol,
} from "@stll/api-contract/sso";
import { declareFingerprintFields } from "@stll/errors";
import { slugify } from "@stll/text-normalize";

import {
  member,
  organizationSsoDomain,
  organizationSsoPolicy,
  ssoProvider,
} from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { domainTxtInstruction } from "@/api/lib/auth/sso-domain-verify";
import type { SafeId } from "@/api/lib/branded-types";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import { admitSsoOidcConfig } from "@/api/lib/db/sso-provider-config";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

const DEFAULT_OIDC_SCOPES = ["openid", "email", "profile"] as const;
const MAX_SSO_PROVIDERS_PER_ORG = 50;
const MAX_SSO_DOMAINS_PER_ORG = 100;

export class SsoManagementError extends TaggedError("sso_management_error")<{
  message: string;
  reason:
    | "invalid_config"
    | "provider_not_found"
    | "last_provider_while_required"
    | "provider_required_to_enforce"
    | "domain_already_exists"
    | "domain_not_found"
    | "domain_verified_elsewhere";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export type SsoManagementDb = Pick<
  Transaction,
  "select" | "insert" | "update" | "delete" | "transaction"
>;

type ProviderUrlBuilders = {
  callbackUrlFor: (providerId: string) => string;
  launchUrlFor: (providerId: string) => string;
};

const splitDomains = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => normalizeSsoDomain(entry))
    .filter((entry) => entry.length > 0);

const generateProviderId = (displayName: string): string => {
  const slug = slugify(displayName, { maxLength: 32, fallback: "idp" });
  return `sso_${slug}_${randomBytes(4).toString("hex")}`;
};

const serializeOidcConfig = (
  entries: readonly (readonly [string, unknown])[],
) => JSON.stringify(Object.fromEntries(entries));

const parseOidcSummaryFields = (
  oidcConfigJson: string | null,
): {
  clientId: string | null;
  hasClientSecret: boolean;
  discoveryEndpoint: string | null;
  scopes: string[];
} => {
  if (oidcConfigJson === null) {
    return {
      clientId: null,
      hasClientSecret: false,
      discoveryEndpoint: null,
      scopes: [],
    };
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(oidcConfigJson),
    catch: () => undefined,
  });
  if (parsed.isErr() || !isRecord(parsed.value)) {
    return {
      clientId: null,
      hasClientSecret: false,
      discoveryEndpoint: null,
      scopes: [],
    };
  }
  const config = parsed.value;
  const rawScopes = config["scopes"];
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((entry): entry is string => typeof entry === "string")
    : [...DEFAULT_OIDC_SCOPES];
  return {
    clientId:
      typeof config["clientId"] === "string" ? config["clientId"] : null,
    hasClientSecret:
      typeof config["clientSecret"] === "string" &&
      config["clientSecret"].length > 0,
    discoveryEndpoint:
      typeof config["discoveryEndpoint"] === "string"
        ? config["discoveryEndpoint"]
        : null,
    scopes,
  };
};

const protocolOfProvider = (row: {
  oidcConfig: string | null;
  samlConfig: string | null;
}): SsoProtocol =>
  row.samlConfig !== null && row.oidcConfig === null ? "saml" : "oidc";

const toProviderSummary = (
  row: typeof ssoProvider.$inferSelect,
  urls: ProviderUrlBuilders,
): OrganizationSsoProviderSummary => {
  const oidc = parseOidcSummaryFields(row.oidcConfig);
  return {
    id: row.id,
    providerId: row.providerId,
    displayName: row.displayName,
    protocol: protocolOfProvider(row),
    issuer: row.issuer,
    domains: splitDomains(row.domain),
    clientId: oidc.clientId,
    hasClientSecret: oidc.hasClientSecret,
    discoveryEndpoint: oidc.discoveryEndpoint,
    scopes: oidc.scopes,
    callbackUrl: urls.callbackUrlFor(row.providerId),
    launchUrl: urls.launchUrlFor(row.providerId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

const toDomainSummary = (
  row: typeof organizationSsoDomain.$inferSelect,
): OrganizationSsoDomainSummary => {
  const { txtHost, txtValue } = domainTxtInstruction(
    row.domain,
    row.verificationToken,
  );
  return {
    id: row.id,
    domain: row.domain,
    status: row.verifiedAt === null ? "pending" : "verified",
    txtHost,
    txtValue,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
};

export const readOrganizationSsoSettings = async (
  db: SsoManagementDb,
  organizationId: SafeId<"organization">,
  urls: ProviderUrlBuilders,
): Promise<OrganizationSsoSettingsResponse> => {
  const [policyRows, providerRows, domainRows] = await Promise.all([
    db
      .select({ requirement: organizationSsoPolicy.requirement })
      .from(organizationSsoPolicy)
      .where(eq(organizationSsoPolicy.organizationId, organizationId))
      .limit(1),
    db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, organizationId))
      .orderBy(asc(ssoProvider.createdAt))
      .limit(MAX_SSO_PROVIDERS_PER_ORG),
    db
      .select()
      .from(organizationSsoDomain)
      .where(eq(organizationSsoDomain.organizationId, organizationId))
      .orderBy(asc(organizationSsoDomain.domain))
      .limit(MAX_SSO_DOMAINS_PER_ORG),
  ]);

  return {
    requirement: policyRows.at(0)?.requirement ?? "optional",
    providers: providerRows.map((row) => toProviderSummary(row, urls)),
    domains: domainRows.map(toDomainSummary),
  };
};

export type CreateOrganizationOidcProviderParams = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryEndpoint?: string;
  domains: readonly string[];
  scopes?: readonly string[];
  urls: ProviderUrlBuilders;
};

// audit: skip - caller handler records organization settings audit event
export const createOrganizationOidcProvider = async (
  db: SsoManagementDb,
  params: CreateOrganizationOidcProviderParams,
): Promise<Result<OrganizationSsoProviderSummary, SsoManagementError>> => {
  const normalizedIssuer = params.issuer.trim().replace(/\/+$/u, "");
  const normalizedDomains = [
    ...new Set(params.domains.map((domain) => normalizeSsoDomain(domain))),
  ].filter((domain) => domain.length > 0);

  if (normalizedDomains.length === 0) {
    return Result.err(
      new SsoManagementError({
        message: "At least one valid domain is required",
        reason: "invalid_config",
      }),
    );
  }

  const discoveryEndpoint =
    params.discoveryEndpoint !== undefined &&
    params.discoveryEndpoint.trim() !== ""
      ? params.discoveryEndpoint.trim()
      : `${normalizedIssuer}/.well-known/openid-configuration`;

  const scopes =
    params.scopes !== undefined && params.scopes.length > 0
      ? [...new Set(params.scopes)]
      : [...DEFAULT_OIDC_SCOPES];

  const oidcConfigJson = serializeOidcConfig([
    ["issuer", normalizedIssuer],
    ["pkce", true],
    ["clientId", params.clientId.trim()],
    ["clientSecret", params.clientSecret],
    ["discoveryEndpoint", discoveryEndpoint],
    ["scopes", scopes],
    ["overrideUserInfo", false],
    ["allowIdpInitiated", false],
  ]);

  const admitted = admitSsoOidcConfig(oidcConfigJson);
  if (admitted.isErr()) {
    return Result.err(
      new SsoManagementError({
        message: admitted.error.message,
        reason: "invalid_config",
      }),
    );
  }

  const providerId = generateProviderId(params.displayName);
  // audit: skip - caller handler records organization settings audit event
  const [inserted] = await db
    .insert(ssoProvider)
    .values({
      id: Bun.randomUUIDv7(),
      providerId,
      displayName: params.displayName.trim(),
      organizationId: params.organizationId,
      issuer: normalizedIssuer,
      domain: normalizedDomains.join(","),
      oidcConfig: admitted.value,
      samlConfig: null,
      userId: params.userId,
    })
    .returning();

  if (inserted === undefined) {
    return Result.err(
      new SsoManagementError({
        message: "Failed to persist SSO provider",
        reason: "invalid_config",
      }),
    );
  }

  return Result.ok(toProviderSummary(inserted, params.urls));
};

// audit: skip - caller handler records organization settings audit event
export const deleteOrganizationSsoProvider = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    providerId: string;
  },
): Promise<Result<{ id: string; providerId: string }, SsoManagementError>> => {
  const existing = await db
    .select({ id: ssoProvider.id, providerId: ssoProvider.providerId })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .limit(MAX_SSO_PROVIDERS_PER_ORG);

  const target = existing.find(
    (row) =>
      row.providerId === params.providerId || row.id === params.providerId,
  );
  if (target === undefined) {
    return Result.err(
      new SsoManagementError({
        message: "SSO provider not found",
        reason: "provider_not_found",
      }),
    );
  }

  if (existing.length === 1) {
    const policy = await db
      .select({ requirement: organizationSsoPolicy.requirement })
      .from(organizationSsoPolicy)
      .where(eq(organizationSsoPolicy.organizationId, params.organizationId))
      .limit(1);
    if (policy.at(0)?.requirement === "required") {
      return Result.err(
        new SsoManagementError({
          message:
            "Disable required SSO before removing the organization's last identity provider",
          reason: "last_provider_while_required",
        }),
      );
    }
  }

  // audit: skip - caller handler records organization settings audit event
  await db
    .delete(ssoProvider)
    .where(
      and(
        eq(ssoProvider.organizationId, params.organizationId),
        eq(ssoProvider.id, target.id),
      ),
    );

  return Result.ok(target);
};

// audit: skip - caller handler records organization settings audit event
export const updateOrganizationSsoRequirement = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    requirement: OrganizationSsoPolicyRequirement;
  },
): Promise<
  Result<{ requirement: OrganizationSsoPolicyRequirement }, SsoManagementError>
> => {
  if (params.requirement === "required") {
    const providers = await db
      .select({ id: ssoProvider.id })
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, params.organizationId))
      .limit(1);
    if (providers.length === 0) {
      return Result.err(
        new SsoManagementError({
          message:
            "Configure at least one SSO identity provider before requiring SSO",
          reason: "provider_required_to_enforce",
        }),
      );
    }
  }

  const existing = await db
    .select({ organizationId: organizationSsoPolicy.organizationId })
    .from(organizationSsoPolicy)
    .where(eq(organizationSsoPolicy.organizationId, params.organizationId))
    .limit(1);

  if (existing.length === 0) {
    // audit: skip - caller handler records organization settings audit event
    await db.insert(organizationSsoPolicy).values({
      organizationId: params.organizationId,
      requirement: params.requirement,
    });
  } else {
    const write = replayWrite(
      organizationSsoPolicy,
      { requirement: params.requirement },
      {
        modifiedAt: {
          column: organizationSsoPolicy.updatedAt,
          value: new Date(),
        },
      },
    );
    // audit: skip - caller handler records organization settings audit event
    await db
      .update(organizationSsoPolicy)
      .set(write.set)
      .where(
        and(
          eq(organizationSsoPolicy.organizationId, params.organizationId),
          write.setWhere,
        ),
      );
  }

  return Result.ok({ requirement: params.requirement });
};

// audit: skip - caller handler records organization settings audit event
export const createOrganizationSsoDomain = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    domain: string;
    createdBy: SafeId<"user">;
  },
): Promise<Result<OrganizationSsoDomainSummary, SsoManagementError>> => {
  const domain = normalizeSsoDomain(params.domain);
  const verificationToken = `${SSO_DOMAIN_TXT_VALUE_PREFIX}${randomBytes(24).toString("base64url")}`;

  const inserted = await Result.tryPromise({
    try: async () =>
      // audit: skip - caller handler records organization settings audit event
      await db
        .insert(organizationSsoDomain)
        .values({
          id: Bun.randomUUIDv7(),
          organizationId: params.organizationId,
          domain,
          verificationToken,
          verifiedAt: null,
          lastCheckedAt: null,
          createdBy: params.createdBy,
        })
        .returning(),
    catch: (error: unknown) => error,
  });

  if (inserted.isErr()) {
    if (isPgError(inserted.error, PG_ERROR.UNIQUE_VIOLATION)) {
      return Result.err(
        new SsoManagementError({
          message: "This domain is already listed for the organization",
          reason: "domain_already_exists",
        }),
      );
    }
    throw inserted.error;
  }

  const row = inserted.value.at(0);
  if (row === undefined) {
    return Result.err(
      new SsoManagementError({
        message: "Failed to create domain record",
        reason: "invalid_config",
      }),
    );
  }

  return Result.ok(toDomainSummary(row));
};

export const readOrganizationSsoDomain = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    domainId: string;
  },
): Promise<typeof organizationSsoDomain.$inferSelect | null> => {
  const rows = await db
    .select()
    .from(organizationSsoDomain)
    .where(
      and(
        eq(organizationSsoDomain.organizationId, params.organizationId),
        eq(organizationSsoDomain.id, params.domainId),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
};

// audit: skip - caller handler records organization settings audit event
export const recordOrganizationSsoDomainCheck = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    domainId: string;
    verified: boolean;
    checkedAt: Date;
  },
): Promise<Result<OrganizationSsoDomainSummary, SsoManagementError>> => {
  const updated = await Result.tryPromise({
    try: async () => {
      const write = replayWrite(
        organizationSsoDomain,
        {
          lastCheckedAt: params.checkedAt,
          ...(params.verified ? { verifiedAt: params.checkedAt } : {}),
        },
        {
          modifiedAt: {
            column: organizationSsoDomain.updatedAt,
            value: params.checkedAt,
          },
        },
      );
      // audit: skip - caller handler records organization settings audit event
      return await db
        .update(organizationSsoDomain)
        .set(write.set)
        .where(
          and(
            eq(organizationSsoDomain.organizationId, params.organizationId),
            eq(organizationSsoDomain.id, params.domainId),
            write.setWhere,
          ),
        )
        .returning();
    },
    catch: (error: unknown) => error,
  });

  if (updated.isErr()) {
    if (isPgError(updated.error, PG_ERROR.UNIQUE_VIOLATION)) {
      return Result.err(
        new SsoManagementError({
          message: "This domain is already verified by another organization",
          reason: "domain_verified_elsewhere",
        }),
      );
    }
    throw updated.error;
  }

  const row = updated.value.at(0);
  if (row === undefined) {
    return Result.err(
      new SsoManagementError({
        message: "Domain not found",
        reason: "domain_not_found",
      }),
    );
  }

  return Result.ok(toDomainSummary(row));
};

// audit: skip - caller handler records organization settings audit event
export const deleteOrganizationSsoDomain = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    domainId: string;
  },
): Promise<Result<{ id: string; domain: string }, SsoManagementError>> => {
  // audit: skip - caller handler records organization settings audit event
  const deleted = await db
    .delete(organizationSsoDomain)
    .where(
      and(
        eq(organizationSsoDomain.organizationId, params.organizationId),
        eq(organizationSsoDomain.id, params.domainId),
      ),
    )
    .returning({
      id: organizationSsoDomain.id,
      domain: organizationSsoDomain.domain,
    });

  const row = deleted.at(0);
  if (row === undefined) {
    return Result.err(
      new SsoManagementError({
        message: "Domain not found",
        reason: "domain_not_found",
      }),
    );
  }

  return Result.ok(row);
};

export const discoverVerifiedSsoProvidersByDomain = async (
  db: SsoManagementDb,
  rawDomain: string,
): Promise<PublicSsoProviderOption[]> => {
  const domain = normalizeSsoDomain(rawDomain);
  if (domain.length === 0) {
    return [];
  }

  const verifiedRows = await db
    .select({ organizationId: organizationSsoDomain.organizationId })
    .from(organizationSsoDomain)
    .where(
      and(
        eq(organizationSsoDomain.domain, domain),
        isNotNull(organizationSsoDomain.verifiedAt),
      ),
    )
    .limit(1);

  const verifiedOrgId = verifiedRows.at(0)?.organizationId;
  if (verifiedOrgId === undefined) {
    return [];
  }

  const providers = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, verifiedOrgId))
    .orderBy(asc(ssoProvider.createdAt))
    .limit(MAX_SSO_PROVIDERS_PER_ORG);

  return providers
    .filter((provider) => splitDomains(provider.domain).includes(domain))
    .map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName,
      protocol: protocolOfProvider(provider),
    }));
};

export const discoverSsoProviderById = async (
  db: SsoManagementDb,
  providerId: string,
): Promise<PublicSsoProviderOption[]> => {
  const providers = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .limit(1);

  return providers.map((provider) => ({
    providerId: provider.providerId,
    displayName: provider.displayName,
    protocol: protocolOfProvider(provider),
  }));
};

export const listOrganizationSsoProvidersForMember = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  },
): Promise<PublicSsoProviderOption[]> => {
  const membership = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    return [];
  }

  const providers = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .orderBy(asc(ssoProvider.createdAt))
    .limit(MAX_SSO_PROVIDERS_PER_ORG);

  return providers.map((provider) => ({
    providerId: provider.providerId,
    displayName: provider.displayName,
    protocol: protocolOfProvider(provider),
  }));
};
