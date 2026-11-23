import * as v from "valibot";

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

/** Normalized RFC-1035 hostname (e.g. `acme.example.com`). */
export const SSO_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export const normalizeSsoDomain = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\.+$/u, "");

export const ssoDomainNameSchema = v.pipe(
  v.string(),
  v.transform(normalizeSsoDomain),
  v.regex(SSO_DOMAIN_PATTERN, "Enter a valid domain name"),
);

export const createOidcSsoProviderBodySchema = v.strictObject({
  displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
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

export const organizationSsoSettingsResponseSchema = v.object({
  requirement: v.picklist(ORGANIZATION_SSO_POLICY_REQUIREMENTS),
  providers: v.array(organizationSsoProviderSummarySchema),
  domains: v.array(organizationSsoDomainSummarySchema),
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
