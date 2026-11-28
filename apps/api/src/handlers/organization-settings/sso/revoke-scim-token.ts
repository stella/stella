import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { revokeOrganizationScimToken } from "@/api/lib/auth/scim-management";

import { mapScimManagementError } from "./sso-error-map";

const paramsSchema = v.object({
  tokenId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
});

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  params: paramsSchema,
  aggregateMutation: {
    type: "independent",
    reason:
      "Serialized inside @better-auth/scim managed-connection native transactions.",
  },
} satisfies HandlerConfig;

const revokeOrganizationScimTokenHandler = createSafeRootHandler(
  config,
  async function* ({ session, user, params, safeDb, recordAuditEvent }) {
    const revoked = await revokeOrganizationScimToken({
      organizationId: session.activeOrganizationId,
      credentialId: params.tokenId,
      actorId: user.id,
    });
    if (revoked.isErr()) {
      return Result.err(mapScimManagementError(revoked.error));
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: params.tokenId,
          metadata: {
            setting: "scim_token",
            credentialId: params.tokenId,
          },
        });
      }),
    );

    return Result.ok(revoked.value);
  },
);

export default revokeOrganizationScimTokenHandler;
