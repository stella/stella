import { Result } from "better-result";

import { createOrganizationSsoDomainBodySchema } from "@stll/api-contract/sso";

import { createOrgSsoDomain } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import { mapSsoManagementError } from "./sso-error-map";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: createOrganizationSsoDomainBodySchema,
} satisfies HandlerConfig;

const createOrganizationSsoDomainHandler = createSafeRootHandler(
  config,
  async function* ({ session, body, recordAuditEvent }) {
    const created = await createOrgSsoDomain({
      organizationId: session.activeOrganizationId,
      domain: body.domain,
      createdBy: session.userId,
    });
    if (created.isErr()) {
      return Result.err(mapSsoManagementError(created.error));
    }

    yield* recordAuditEvent({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: created.value.id,
      details: {
        setting: "sso_domain",
        domain: created.value.domain,
      },
    });

    return Result.ok(created.value);
  },
);

export default createOrganizationSsoDomainHandler;
