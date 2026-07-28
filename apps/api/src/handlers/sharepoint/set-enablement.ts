import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { env } from "@/api/env";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { disableAndPurgeSharepointForOrg } from "@/api/lib/sharepoint-disable-purge";

const requestBody = t.Object({
  enabled: t.Boolean(),
});

const config = {
  permissions: { organizationSettings: ["update"] },
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
      const purge = await Result.tryPromise({
        try: async () =>
          await disableAndPurgeSharepointForOrg({
            organizationId,
            recordAuditEvent,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to disable the SharePoint connection",
            cause,
          }),
      });
      if (Result.isError(purge)) {
        return Result.err(purge.error);
      }
      return Result.ok({ enabled: false });
    }

    if (!env.FEATURE_SHAREPOINT) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: { sharepointConnectionEnabled: true },
        });

        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId,
            sharepointConnectionEnabled: true,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: { sharepointConnectionEnabled: true, updatedAt: new Date() },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: organizationId,
          workspaceId: null,
          changes: {
            sharepointConnectionEnabled: {
              old: existing?.sharepointConnectionEnabled ?? false,
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
