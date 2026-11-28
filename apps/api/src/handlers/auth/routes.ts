import { discoverSsoBodySchema } from "@stll/api-contract/sso";
import type { AuthSocialProviderId } from "@stll/auth-model";

import {
  discoverSsoByEmailDomain,
  discoverSsoByProviderId,
  listOrgSsoProvidersForMember,
} from "@/api/db/root";
import { env } from "@/api/env";
import { createAuthMetadataPreflightHeaders } from "@/api/handlers/auth/metadata";
import metadataHandler from "@/api/handlers/auth/read-authorization-server-metadata";
import { mount, routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { getAuth } from "@/api/lib/auth";
import { configuredAppleSignIn } from "@/api/lib/auth/apple-sign-in-env";
import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import { isReviewAccountConfigured } from "@/api/lib/auth/review-account";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { isEnterpriseSsoDeployed } from "@/api/lib/db/sso-access";
import { isTransactionalEmailConfigured } from "@/api/lib/email/email";
import { normalizeEmail } from "@/api/lib/email/normalized-email";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  isSelfhostFirstUserRequired,
  isSelfhostLocalPasswordAuthEnabled,
} from "@/api/lib/selfhost-auth";

/**
 * A discovery document's preflight, answered by the route itself so the
 * credentialed CORS layer never sees it: any origin may read the metadata,
 * a third-party MCP client's included.
 */
const metadataPreflight = defineEndpoint.public({ cors: "own" }, ({ set }) => {
  for (const [key, value] of createAuthMetadataPreflightHeaders()) {
    set.headers[key] = value;
  }
  return status(204);
});

export const authMetadataRoute = routes({
  [ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH]: {
    GET: metadataHandler,
    OPTIONS: metadataPreflight,
  },
  [OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH]: {
    GET: metadataHandler,
    OPTIONS: metadataPreflight,
  },
  [OPENID_CONFIGURATION_DISCOVERY_PATH]: {
    GET: metadataHandler,
    OPTIONS: metadataPreflight,
  },
});

const getSocialAuthCapabilities = () =>
  ({
    google: !!(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET),
    microsoft: !!(
      env.MICROSOFT_AUTH_CLIENT_ID &&
      env.MICROSOFT_AUTH_CLIENT_SECRET &&
      env.MICROSOFT_AUTH_TENANT_ID
    ),
    apple: configuredAppleSignIn().type === "enabled",
  }) satisfies Record<AuthSocialProviderId, boolean>;

const authCapabilities = defineEndpoint.public({}, async () => {
  const firstUserRequired = await isSelfhostFirstUserRequired();
  const bootstrap = firstUserRequired && !!env.SELFHOST_BOOTSTRAP_TOKEN;
  return {
    emailOtp: isTransactionalEmailConfigured() && !firstUserRequired,
    localPassword: isSelfhostLocalPasswordAuthEnabled(),
    // One restricted account signs in with a password; the sign-in page
    // offers the form quietly instead of as a primary option.
    reviewPasswordSignIn: isReviewAccountConfigured(),
    bootstrap,
    social: getSocialAuthCapabilities(),
    // Whether this deployment can deliver a confirmation code at all. Separate
    // from `emailOtp` (a sign-in option, which the bootstrap state also
    // suppresses): account settings read this to decide whether an emailed
    // confirmation step is part of a flow.
    transactionalEmail: isTransactionalEmailConfigured(),
    enterpriseSso: isEnterpriseSsoDeployed(),
  };
});

/**
 * Public SSO provider lookup for the sign-in screen. Email-domain discovery
 * only resolves domains that an organization has verified via DNS TXT; it
 * never reveals whether an account or unverified organization exists.
 */
const discoverSso = defineEndpoint.public(
  { body: discoverSsoBodySchema },
  async ({ body }) => {
    if (body.by === "email") {
      const normalized = normalizeEmail(body.email);
      const atIndex = normalized.lastIndexOf("@");
      const domain = atIndex === -1 ? "" : normalized.slice(atIndex + 1);
      const providers = await discoverSsoByEmailDomain(domain);
      return { providers };
    }
    const providers = await discoverSsoByProviderId(body.providerId);
    return { providers };
  },
);

/**
 * Lists the SSO providers for an organization the signed-in user belongs to,
 * without enforcing the organization's SSO requirement so a member who
 * received `sso_sign_in_required` can start SSO re-authentication in place.
 */
declareAggregateMutation(discoverSso, {
  type: "independent",
  reason:
    "Read-only public SSO provider discovery lookup with no persisted mutation.",
});

export const readMemberOrganizationSsoProviders = defineEndpoint.public(
  {},
  async ({ request }) => {
    const authSession = await getAuth().api.getSession({
      headers: request.headers,
    });
    if (authSession === null) {
      return status(401, {
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    const targetOrgId = authSession.session.activeOrganizationId;
    if (typeof targetOrgId !== "string" || targetOrgId.length === 0) {
      return { providers: [] };
    }
    const providers = await listOrgSsoProvidersForMember({
      organizationId: brandPersistedOrganizationId(targetOrgId),
      userId: brandPersistedUserId(authSession.user.id),
    });
    return { providers };
  },
);

export const authCapabilitiesRoute = mount(
  [
    routes({ "/capabilities": { GET: authCapabilities } }),
    routes(
      {
        "/sso/discover": { POST: discoverSso },
        "/sso/organization-providers": {
          GET: readMemberOrganizationSsoProviders,
        },
      },
      { deployment: { type: "flag", flag: "FEATURE_ENTERPRISE_SSO" } },
    ),
  ],
  { prefix: "/auth" },
);
