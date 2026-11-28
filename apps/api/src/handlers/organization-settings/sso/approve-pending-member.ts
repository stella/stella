import { Result } from "better-result";
import * as v from "valibot";

import { approveOrgSsoPendingMember } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import { mapSsoProvisioningError } from "./sso-error-map";

const paramsSchema = v.strictObject({
  pendingId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
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
      "Serialized inside rootDb via withAggregateTransaction and withAggregateLock on organization.",
  },
} satisfies HandlerConfig;

const approveOrganizationSsoPendingMemberHandler = createSafeRootHandler(
  config,
  async function* ({ session, user, params, safeDb, recordAuditEvent }) {
    const approved = await approveOrgSsoPendingMember({
      organizationId: session.activeOrganizationId,
      pendingId: params.pendingId,
      reviewedBy: user.id,
    });
    if (approved.isErr()) {
      return Result.err(mapSsoProvisioningError(approved.error));
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: approved.value.id,
          metadata: {
            setting: "sso_pending_member",
            decision: "approved",
            userId: approved.value.userId,
          },
        });
      }),
    );

    return Result.ok({ approved: true as const, id: approved.value.id });
  },
);

export default approveOrganizationSsoPendingMemberHandler;
