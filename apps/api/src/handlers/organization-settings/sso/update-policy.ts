import { Result } from "better-result";

import { updateOrganizationSsoPolicyBodySchema } from "@stll/api-contract/sso";

import { updateOrgSsoRequirement } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

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
          },
        });
      }),
    );

    return Result.ok(updated.value);
  },
);

export default updateOrganizationSsoPolicyHandler;
