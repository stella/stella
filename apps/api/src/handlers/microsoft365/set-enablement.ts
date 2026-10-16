import { Result } from "better-result";
import { t } from "elysia";

import { MICROSOFT365_CAPABILITIES } from "@stll/api-contract/microsoft365";

import { organizationSettings } from "@/api/db/schema";
import { microsoft365RealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { disableAndPurgeMicrosoft365ForOrg } from "@/api/lib/microsoft365-disable-purge";

const requestBody = t.Object({
  enabled: t.Boolean(),
  capabilities: t.Array(t.UnionEnum(MICROSOFT365_CAPABILITIES), {
    maxItems: 2,
  }),
});

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: microsoft365RealtimeUpdates,
  mcp: { type: "internal", reason: "provider_secret" },
  body: requestBody,
} satisfies HandlerConfig;

// Org-admin toggle for the delegated Microsoft 365 connection. Dashboard-only
// (internal): org enablement of an internal feature is not an agent-facing
// capability, so it stays out of the CLI/MCP catalog.
//
// Enabling requires the deployment feature flag. Disabling is a revocation:
// it purges every member's stored tokens (see microsoft365-disable-purge) and
// is always allowed, even when the deployment flag is off, so a kill switch
// can never be blocked.
const setMicrosoft365Enablement = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    if (!body.enabled) {
      const purge = await Result.tryPromise({
        try: async () =>
          await disableAndPurgeMicrosoft365ForOrg({
            organizationId,
            recordAuditEvent,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to disable the Microsoft 365 connection",
            cause,
          }),
      });
      if (Result.isError(purge)) {
        return Result.err(purge.error);
      }
      return Result.ok({ enabled: false });
    }

    if (!isDeploymentFeatureEnabled("FEATURE_MICROSOFT365")) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "organization",
          id: organizationId,
          mode: "update",
        });
        const existing = await tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: {
            microsoft365ConnectionEnabled: true,
            microsoft365FilesReadEnabled: true,
            microsoft365CalendarReadEnabled: true,
          },
        });

        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId,
            microsoft365ConnectionEnabled: true,
            microsoft365FilesReadEnabled:
              body.capabilities.includes("files.read"),
            microsoft365CalendarReadEnabled:
              body.capabilities.includes("calendar.read"),
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              microsoft365ConnectionEnabled: true,
              microsoft365FilesReadEnabled:
                body.capabilities.includes("files.read"),
              microsoft365CalendarReadEnabled:
                body.capabilities.includes("calendar.read"),
              updatedAt: new Date(),
            },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: organizationId,
          workspaceId: null,
          changes: {
            microsoft365FilesReadEnabled: {
              old: existing?.microsoft365FilesReadEnabled ?? false,
              new: body.capabilities.includes("files.read"),
            },
            microsoft365CalendarReadEnabled: {
              old: existing?.microsoft365CalendarReadEnabled ?? false,
              new: body.capabilities.includes("calendar.read"),
            },
            microsoft365ConnectionEnabled: {
              old: existing?.microsoft365ConnectionEnabled ?? false,
              new: true,
            },
          },
        });
      }),
    );

    return Result.ok({ enabled: true });
  },
);

export default setMicrosoft365Enablement;
