import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { MICROSOFT365_CAPABILITIES } from "@stll/api-contract/microsoft365";

import { organizationSettings } from "@/api/db/schema";
import { sharepointRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { lockSharepointPolicy } from "@/api/lib/db/sharepoint-policy-lock";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { disableAndPurgeSharepointForOrg } from "@/api/lib/sharepoint-disable-purge";

const requestBody = v.object({
  capabilities: v.pipe(
    v.array(v.picklist(MICROSOFT365_CAPABILITIES)),
    v.maxLength(MICROSOFT365_CAPABILITIES.length),
  ),
});

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: sharepointRealtimeUpdates,
  mcp: { type: "internal", reason: "provider_secret" },
  body: requestBody,
} satisfies HandlerConfig;

// This endpoint changes individual capability policy. The deployed
// /enablement endpoint remains the whole-organization kill operation.
export const createSetSharepointCapabilities = (
  deploymentEnabled: typeof isDeploymentFeatureEnabled = isDeploymentFeatureEnabled,
) =>
  createSafeRootHandler(
    config,
    async function* ({ body, safeDb, session, recordAuditEvent }) {
      const organizationId = session.activeOrganizationId;
      if (body.capabilities.length === 0) {
        const purge = await disableAndPurgeSharepointForOrg({
          organizationId,
          recordAuditEvent,
        });
        if (Result.isError(purge)) {
          return Result.err(purge.error);
        }
        return Result.ok({ capabilities: [] });
      }

      if (!deploymentEnabled("FEATURE_SHAREPOINT")) {
        return Result.err(
          new HandlerError({ status: 404, message: "Not found" }),
        );
      }

      const filesReadEnabled = body.capabilities.includes("files.read");
      const calendarReadEnabled = body.capabilities.includes("calendar.read");
      yield* Result.await(
        safeDb(async (tx) => {
          const previous = await lockSharepointPolicy({
            tx,
            organizationId,
            recordAuditEvent,
          });

          // The marker is local to scopedDb's transaction and bound to this
          // server-derived org. Old API tasks never set it; their file-off write
          // clears calendar policy in the database trigger, including false-to-false.
          await tx.execute(
            sql`SELECT pg_catalog.set_config('app.microsoft365_capability_policy_org', ${organizationId}, true)`,
          );
          await tx
            .update(organizationSettings)
            .set({
              sharepointConnectionEnabled: filesReadEnabled,
              microsoft365CalendarReadEnabled: calendarReadEnabled,
              updatedAt: new Date(),
            })
            .where(eq(organizationSettings.organizationId, organizationId));

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: organizationId,
            workspaceId: null,
            changes: {
              sharepointConnectionEnabled: {
                old: previous.sharepointConnectionEnabled,
                new: filesReadEnabled,
              },
              microsoft365CalendarReadEnabled: {
                old: previous.microsoft365CalendarReadEnabled,
                new: calendarReadEnabled,
              },
            },
          });
        }),
      );

      return Result.ok({ capabilities: body.capabilities });
    },
  );

const setSharepointCapabilities = createSetSharepointCapabilities();

declareAggregateMutation(setSharepointCapabilities, {
  type: "aggregate",
  aggregates: ["sharepointPolicy"],
});

export default setSharepointCapabilities;
