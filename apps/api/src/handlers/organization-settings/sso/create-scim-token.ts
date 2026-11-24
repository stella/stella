import { Result } from "better-result";

import { createOrganizationScimTokenBodySchema } from "@stll/api-contract/sso";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createOrganizationScimToken } from "@/api/lib/auth/scim-management";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { mapScimManagementError } from "./sso-error-map";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: createOrganizationScimTokenBodySchema,
} satisfies HandlerConfig;

const createOrganizationScimTokenHandler = createSafeRootHandler(
  config,
  async function* ({ session, user, body, safeDb, recordAuditEvent }) {
    const created = await createOrganizationScimToken({
      organizationId: session.activeOrganizationId,
      actorId: user.id,
      expiresInDays: body.expiresInDays,
    });
    if (created.isErr()) {
      return Result.err(mapScimManagementError(created.error));
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: created.value.token.id,
          metadata: {
            setting: "scim_token",
            credentialId: created.value.token.id,
            expiresAt: created.value.token.expiresAt,
          },
        });
      }),
    );

    return Result.ok(created.value);
  },
);

declareAggregateMutation(createOrganizationScimTokenHandler, {
  type: "independent",
  reason:
    "Serialized inside @better-auth/scim managed-connection native transactions.",
});

export default createOrganizationScimTokenHandler;
