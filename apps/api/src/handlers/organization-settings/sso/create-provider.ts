import { Result } from "better-result";

import { createOidcSsoProviderBodySchema } from "@stll/api-contract/sso";

import { createOrgOidcProvider } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { deriveDiscoveryEndpoint } from "@/api/lib/auth/sso-discovery";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { mapOidcDiscoveryError, mapSsoManagementError } from "./sso-error-map";
import { ssoProviderUrls } from "./sso-urls";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: createOidcSsoProviderBodySchema,
} satisfies HandlerConfig;

const createOrganizationSsoProvider = createSafeRootHandler(
  config,
  async function* ({ session, body, recordAuditEvent }) {
    const issuerParsed = Result.try({
      try: () => new URL(body.issuer),
      catch: () => undefined,
    });
    if (issuerParsed.isErr() || issuerParsed.value.protocol !== "https:") {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "sso_oidc_invalid_url",
          message: "OIDC issuer URL must use HTTPS",
        }),
      );
    }

    const discovery = deriveDiscoveryEndpoint(
      body.issuer,
      body.discoveryEndpoint,
    );
    if (discovery.isErr()) {
      return Result.err(mapOidcDiscoveryError(discovery.error));
    }

    const created = await createOrgOidcProvider({
      organizationId: session.activeOrganizationId,
      userId: session.userId,
      displayName: body.displayName,
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      discoveryEndpoint: discovery.value,
      domains: body.domains,
      scopes: body.scopes,
      urls: ssoProviderUrls,
    });
    if (created.isErr()) {
      return Result.err(mapSsoManagementError(created.error));
    }

    yield* recordAuditEvent({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: created.value.id,
      details: {
        setting: "sso_provider",
        providerId: created.value.providerId,
        protocol: created.value.protocol,
        issuer: created.value.issuer,
        domains: created.value.domains,
      },
    });

    return Result.ok(created.value);
  },
);

export default createOrganizationSsoProvider;
