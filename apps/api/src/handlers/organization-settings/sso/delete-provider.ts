import { Result } from "better-result";
import * as v from "valibot";

import { deleteOrgSsoProvider } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import { mapSsoManagementError } from "./sso-error-map";

const paramsSchema = v.strictObject({
  providerId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
});

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  params: paramsSchema,
} satisfies HandlerConfig;

const deleteOrganizationSsoProvider = createSafeRootHandler(
  config,
  async function* ({ session, params, recordAuditEvent }) {
    const deleted = await deleteOrgSsoProvider({
      organizationId: session.activeOrganizationId,
      providerId: params.providerId,
    });
    if (deleted.isErr()) {
      return Result.err(mapSsoManagementError(deleted.error));
    }

    yield* recordAuditEvent({
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: deleted.value.id,
      details: {
        setting: "sso_provider",
        providerId: deleted.value.providerId,
      },
    });

    return Result.ok({ deleted: true as const, id: deleted.value.id });
  },
);

export default deleteOrganizationSsoProvider;
