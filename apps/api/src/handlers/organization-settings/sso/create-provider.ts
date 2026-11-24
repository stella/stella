import { Result } from "better-result";

import { createOidcSsoProviderBodySchema } from "@stll/api-contract/sso";

import { createOrgOidcProvider } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { probeOidcDiscovery } from "@/api/lib/auth/sso-discovery";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { mapOidcDiscoveryError, mapSsoManagementError } from "./sso-error-map";
import { ssoProviderUrls } from "./sso-urls";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: createOidcSsoProviderBodySchema,
} satisfies HandlerConfig;

const createOrganizationSsoProviderHandler = createSafeRootHandler(
  config,
  async function* ({ session, user, body, safeDb, recordAuditEvent }) {
    const discovery = await probeOidcDiscovery({
      issuer: body.issuer,
      ...(body.discoveryEndpoint !== undefined
        ? { discoveryEndpoint: body.discoveryEndpoint }
        : {}),
      permit: grantThirdPartyOutboundPermit(),
    });
    if (discovery.isErr()) {
      return Result.err(mapOidcDiscoveryError(discovery.error));
    }

    const created = await createOrgOidcProvider({
      organizationId: session.activeOrganizationId,
      userId: user.id,
      displayName: body.displayName,
      issuer: discovery.value.issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      discoveryEndpoint: discovery.value.discoveryEndpoint,
      domains: body.domains,
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
      urls: ssoProviderUrls,
    });
    if (created.isErr()) {
      return Result.err(mapSsoManagementError(created.error));
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: created.value.id,
          metadata: {
            setting: "sso_provider",
            providerId: created.value.providerId,
            issuer: created.value.issuer,
            domains: created.value.domains,
          },
        });
      }),
    );

    return Result.ok(created.value);
  },
);

declareAggregateMutation(createOrganizationSsoProviderHandler, {
  type: "independent",
  reason: "Provider uniqueness is enforced by unique indexes on sso_provider.",
});

export default createOrganizationSsoProviderHandler;
