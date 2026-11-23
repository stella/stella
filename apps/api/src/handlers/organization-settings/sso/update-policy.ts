import { Result } from "better-result";

import { updateOrganizationSsoPolicyBodySchema } from "@stll/api-contract/sso";

import { updateOrgSsoRequirement } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { mapSsoManagementError } from "./sso-error-map";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: updateOrganizationSsoPolicyBodySchema,
} satisfies HandlerConfig;

const updateOrganizationSsoPolicyHandler = createSafeRootHandler(
  config,
  async function* ({ session, body, safeDb, recordAuditEvent }) {
    const updated = await updateOrgSsoRequirement({
      organizationId: session.activeOrganizationId,
      requirement: body.requirement,
      ...(body.provisioningMode !== undefined
        ? { provisioningMode: body.provisioningMode }
        : {}),
      ...(body.seatLimit !== undefined ? { seatLimit: body.seatLimit } : {}),
    });
    if (updated.isErr()) {
      return Result.err(mapSsoManagementError(updated.error));
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            setting: "sso_policy",
            requirement: updated.value.requirement,
            provisioningMode: updated.value.provisioningMode,
            seatLimit: updated.value.seatLimit,
          },
        });
      }),
    );

    return Result.ok(updated.value);
  },
);

declareAggregateMutation(updateOrganizationSsoPolicyHandler, {
  type: "independent",
  reason:
    "Serialized inside rootDb via withAggregateTransaction and withAggregateLock on organization.",
});

export default updateOrganizationSsoPolicyHandler;
