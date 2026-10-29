import { Result } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { organizationSettings } from "@/api/db/schema";
import { sharepointRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockSharepointPolicy } from "@/api/lib/db/sharepoint-policy-lock";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { disableAndPurgeSharepointForOrg } from "@/api/lib/sharepoint-disable-purge";

const requestBody = v.object({ enabled: v.boolean() });

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: sharepointRealtimeUpdates,
  mcp: { type: "internal", reason: "provider_secret" },
  body: requestBody,
} satisfies HandlerConfig;

// Org-admin toggle for the delegated SharePoint connection. Dashboard-only
// (internal): org enablement of an internal feature is not an agent-facing
// capability, so it stays out of the CLI/MCP catalog.
//
// Enabling requires the deployment feature flag. Disabling is a revocation:
// it purges every member's stored tokens (see sharepoint-disable-purge) and
// is always allowed, even when the deployment flag is off, so a kill switch
// can never be blocked.
const setSharepointEnablement = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    if (!body.enabled) {
      const purge = await disableAndPurgeSharepointForOrg({
        organizationId,
        recordAuditEvent,
      });
      if (Result.isError(purge)) {
        return Result.err(purge.error);
      }
      return Result.ok({ enabled: false });
    }

    if (!isDeploymentFeatureEnabled("FEATURE_SHAREPOINT")) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        const existing = await lockSharepointPolicy({
          tx,
          organizationId,
          recordAuditEvent,
        });
        await tx
          .update(organizationSettings)
          .set({ sharepointConnectionEnabled: true, updatedAt: new Date() })
          .where(eq(organizationSettings.organizationId, organizationId));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: organizationId,
          workspaceId: null,
          changes: {
            sharepointConnectionEnabled: {
              old: existing.sharepointConnectionEnabled,
              new: true,
            },
          },
        });
      }),
    );

    return Result.ok({ enabled: true });
  },
);

export default setSharepointEnablement;
