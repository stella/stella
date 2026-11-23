import * as v from "valibot";

import { displayNameSchema } from "./display-name";

/**
 * The error code a request answers with when its organization requires
 * single sign-on and the session was not created by that organization's
 * identity provider. Only that organization refuses the session: the
 * account stays signed in, and the client offers the organization's SSO
 * sign-in instead of signing out.
 */
export const SSO_SIGN_IN_REQUIRED_CODE = "sso_sign_in_required";

/** Supported SSO protocols. */
export const SSO_PROTOCOLS = ["oidc", "saml"] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];

/** DNS TXT verification record value prefix. */
export const SSO_DOMAIN_TXT_VALUE_PREFIX = "stella-sso-verify=";

/** DNS TXT verification subdomain host prefix. */
export const SSO_DOMAIN_TXT_HOST_PREFIX = "_stella-verification.";

/** Domain verification states exposed to organization administrators. */
export const SSO_DOMAIN_STATUSES = ["pending", "verified"] as const;
export type SsoDomainStatus = (typeof SSO_DOMAIN_STATUSES)[number];

/** Public error codes returned on the SSO callback redirect query string. */
export const SSO_CALLBACK_ERROR_CODES = [
  "sso_unavailable",
  "sso_protocol_unavailable",
  "sso_email_unverified",
  "sso_email_domain_not_allowed",
  "sso_account_link_unavailable",
  "sso_provider_replaced",
  "sso_nonce_mismatch",
  "sso_sign_in_failed",
] as const;

export type SsoCallbackErrorCode = (typeof SSO_CALLBACK_ERROR_CODES)[number];

const SSO_CALLBACK_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  SSO_CALLBACK_ERROR_CODES,
);

export const isSsoCallbackErrorCode = (
  value: string,
): value is SsoCallbackErrorCode => SSO_CALLBACK_ERROR_CODE_SET.has(value);

/** Whether an organization requires SSO for member access. */
export const ORGANIZATION_SSO_POLICY_REQUIREMENTS = [
  "optional",
  "required",
] as const;

export type OrganizationSsoPolicyRequirement =
  (typeof ORGANIZATION_SSO_POLICY_REQUIREMENTS)[number];

export const ORGANIZATION_SSO_PROVISIONING_MODES = [
  "invite_only",
  "admin_approval",
  "jit_active",
] as const;

export type OrganizationSsoProvisioningMode =
  (typeof ORGANIZATION_SSO_PROVISIONING_MODES)[number];

export const SSO_PENDING_MEMBER_REASONS = [
  "admin_approval",
  "seat_limit_reached",
] as const;

export type SsoPendingMemberReason =
  (typeof SSO_PENDING_MEMBER_REASONS)[number];

export const SSO_PENDING_MEMBER_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;

export type SsoPendingMemberStatus =
  (typeof SSO_PENDING_MEMBER_STATUSES)[number];

/** Normalized RFC-1035 hostname (e.g. `acme.example.com`). */
export const SSO_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export const normalizeSsoDomain = (raw: string): string =>
  (() => {
    let trimmed = raw.trim().toLowerCase();
    while (trimmed.endsWith(".")) {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
  })();

export const ssoDomainNameSchema = v.pipe(
  v.string(),
  v.transform(normalizeSsoDomain),
  v.regex(SSO_DOMAIN_PATTERN, "Enter a valid domain name"),
);

export const createOidcSsoProviderBodySchema = v.strictObject({
  displayName: displayNameSchema({ maxLength: 80 }),
  issuer: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(512)),
  clientId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  clientSecret: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  discoveryEndpoint: v.optional(
    v.pipe(v.string(), v.trim(), v.url(), v.maxLength(512)),
  ),
  domains: v.pipe(
    v.array(ssoDomainNameSchema),
    v.minLength(1),
    v.maxLength(20),
  ),
  scopes: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64))),
      v.minLength(1),
      v.maxLength(16),
    ),
  ),
});

export type CreateOidcSsoProviderBody = v.InferOutput<
  typeof createOidcSsoProviderBodySchema
>;

export const createSamlSsoProviderBodySchema = v.strictObject({
  providerId: v.optional(
    v.pipe(v.string(), v.trim(), v.regex(/^sso_[a-z0-9_-]{4,48}$/u)),
  ),
  displayName: displayNameSchema({ maxLength: 80 }),
  issuer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512)),
  entryPoint: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(512)),
  cert: v.pipe(v.string(), v.trim(), v.minLength(32), v.maxLength(16_384)),
  domains: v.pipe(
    v.array(ssoDomainNameSchema),
    v.minLength(1),
    v.maxLength(20),
  ),
});

export type CreateSamlSsoProviderBody = v.InferOutput<
  typeof createSamlSsoProviderBodySchema
>;

export const testOidcSsoProviderBodySchema = v.strictObject({
  issuer: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(512)),
  discoveryEndpoint: v.optional(
    v.pipe(v.string(), v.trim(), v.url(), v.maxLength(512)),
  ),
});

export type TestOidcSsoProviderBody = v.InferOutput<
  typeof testOidcSsoProviderBodySchema
>;

export const updateOrganizationSsoPolicyBodySchema = v.strictObject({
  requirement: v.picklist(ORGANIZATION_SSO_POLICY_REQUIREMENTS),
  provisioningMode: v.optional(v.picklist(ORGANIZATION_SSO_PROVISIONING_MODES)),
  seatLimit: v.optional(
    v.nullable(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
    ),
  ),
});

export type UpdateOrganizationSsoPolicyBody = v.InferOutput<
  typeof updateOrganizationSsoPolicyBodySchema
>;

export const createOrganizationSsoDomainBodySchema = v.strictObject({
  domain: ssoDomainNameSchema,
});

export type CreateOrganizationSsoDomainBody = v.InferOutput<
  typeof createOrganizationSsoDomainBodySchema
>;

export const discoverSsoBodySchema = v.variant("by", [
  v.strictObject({
    by: v.literal("email"),
    email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  }),
  v.strictObject({
    by: v.literal("providerId"),
    providerId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  }),
]);

export type DiscoverSsoBody = v.InferOutput<typeof discoverSsoBodySchema>;

export const organizationSsoProviderSummarySchema = v.object({
  id: v.string(),
  providerId: v.string(),
  displayName: v.nullable(v.string()),
  protocol: v.picklist(SSO_PROTOCOLS),
  issuer: v.string(),
  domains: v.array(v.string()),
  clientId: v.nullable(v.string()),
  hasClientSecret: v.boolean(),
  discoveryEndpoint: v.nullable(v.string()),
  scopes: v.array(v.string()),
  callbackUrl: v.string(),
  acsUrl: v.nullable(v.string()),
  spMetadataUrl: v.nullable(v.string()),
  launchUrl: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export type OrganizationSsoProviderSummary = v.InferOutput<
  typeof organizationSsoProviderSummarySchema
>;

export const organizationSsoDomainSummarySchema = v.object({
  id: v.string(),
  domain: v.string(),
  status: v.picklist(SSO_DOMAIN_STATUSES),
  txtHost: v.string(),
  txtValue: v.string(),
  verifiedAt: v.nullable(v.string()),
  lastCheckedAt: v.nullable(v.string()),
  createdAt: v.string(),
});

export type OrganizationSsoDomainSummary = v.InferOutput<
  typeof organizationSsoDomainSummarySchema
>;

export const organizationSsoPendingMemberSummarySchema = v.object({
  id: v.string(),
  userId: v.string(),
  email: v.string(),
  name: v.nullable(v.string()),
  reason: v.picklist(SSO_PENDING_MEMBER_REASONS),
  status: v.picklist(SSO_PENDING_MEMBER_STATUSES),
  createdAt: v.string(),
});

export type OrganizationSsoPendingMemberSummary = v.InferOutput<
  typeof organizationSsoPendingMemberSummarySchema
>;

export const organizationSsoSettingsResponseSchema = v.object({
  requirement: v.picklist(ORGANIZATION_SSO_POLICY_REQUIREMENTS),
  provisioningMode: v.picklist(ORGANIZATION_SSO_PROVISIONING_MODES),
  seatLimit: v.nullable(v.number()),
  activeSeatCount: v.number(),
  providers: v.array(organizationSsoProviderSummarySchema),
  domains: v.array(organizationSsoDomainSummarySchema),
  pendingMembers: v.array(organizationSsoPendingMemberSummarySchema),
});

export type OrganizationSsoSettingsResponse = v.InferOutput<
  typeof organizationSsoSettingsResponseSchema
>;

export const publicSsoProviderOptionSchema = v.object({
  providerId: v.string(),
  displayName: v.nullable(v.string()),
  protocol: v.picklist(SSO_PROTOCOLS),
});

export type PublicSsoProviderOption = v.InferOutput<
  typeof publicSsoProviderOptionSchema
>;

export const discoverSsoResponseSchema = v.object({
  providers: v.array(publicSsoProviderOptionSchema),
});

export type DiscoverSsoResponse = v.InferOutput<
  typeof discoverSsoResponseSchema
>;

export const testOidcSsoProviderResponseSchema = v.object({
  issuer: v.string(),
  discoveryEndpoint: v.string(),
  authorizationEndpoint: v.string(),
  tokenEndpoint: v.string(),
  jwksUri: v.string(),
});

export type TestOidcSsoProviderResponse = v.InferOutput<
  typeof testOidcSsoProviderResponseSchema
>;

export const SAML_METADATA_MAX_BYTES = 512 * 1024;

export const parseSamlMetadataBodySchema = /* @__PURE__ */ v.union([
  /* @__PURE__ */ v.strictObject({
    source: /* @__PURE__ */ v.literal("url"),
    metadataUrl: /* @__PURE__ */ v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(2048),
      v.url(),
    ),
  }),
  /* @__PURE__ */ v.strictObject({
    source: /* @__PURE__ */ v.literal("xml"),
    xml: /* @__PURE__ */ v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(SAML_METADATA_MAX_BYTES),
    ),
  }),
]);

export type ParseSamlMetadataBody = v.InferOutput<
  typeof parseSamlMetadataBodySchema
>;

export const parseSamlMetadataResponseSchema = /* @__PURE__ */ v.object({
  issuer: v.string(),
  entryPoint: v.string(),
  cert: v.string(),
});

export type ParseSamlMetadataResponse = v.InferOutput<
  typeof parseSamlMetadataResponseSchema
>;
