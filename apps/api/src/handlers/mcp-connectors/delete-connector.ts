import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { mcpConnectors } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const routeParams = t.Object({
  slug: t.String({ minLength: 1, maxLength: 80 }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  params: routeParams,
} satisfies HandlerConfig;

const deleteMcpConnector = createSafeRootHandler(
  config,
  async function* ({
    params: requestParams,
    safeDb,
    session,
    recordAuditEvent,
  }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(mcpConnectors)
          .where(
            and(
              eq(mcpConnectors.slug, requestParams.slug),
              eq(mcpConnectors.organizationId, session.activeOrganizationId),
            ),
          )
          .returning({ slug: mcpConnectors.slug });

        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            metadata: {
              field: "mcpConnector",
              slug: row.slug,
            },
          });
        }

        return rows;
      }),
    );

    const connector = deleted.at(0);
    if (!connector) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Custom MCP connector not found",
        }),
      );
    }

    return Result.ok(connector);
  },
);

export default deleteMcpConnector;
