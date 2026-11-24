import { Result } from "better-result";

import { createSamlSsoProviderBodySchema } from "@stll/api-contract/sso";

import { createOrgSamlProvider } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { mapSsoManagementError } from "./sso-error-map";
import { ssoProviderUrls } from "./sso-urls";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: createSamlSsoProviderBodySchema,
} satisfies HandlerConfig;

const createOrganizationSamlSsoProvider = createSafeRootHandler(
  config,
  async function* ({ session, user, body, safeDb, recordAuditEvent }) {
    const created = await createOrgSamlProvider({
      organizationId: session.activeOrganizationId,
      userId: user.id,
      ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
      displayName: body.displayName,
      issuer: body.issuer,
      entryPoint: body.entryPoint,
      cert: body.cert,
      domains: body.domains,
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
            protocol: created.value.protocol,
            issuer: created.value.issuer,
            domains: created.value.domains,
          },
        });
      }),
    );

    return Result.ok(created.value);
  },
);

declareAggregateMutation(createOrganizationSamlSsoProvider, {
  type: "independent",
  reason: "Provider uniqueness is enforced by unique indexes on sso_provider.",
});

export default createOrganizationSamlSsoProvider;
