import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { entityViews } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { entityViewParams, viewOwner } from "./shared";

const config = {
  description:
    "Delete one personal cross-matter view. This does not delete its records or proposals.",
  permissions: { view: ["delete"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: entityViewParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user, recordAuditEvent }) {
    const removed = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${user.id}))`,
        );
        const row = (
          await tx
            .delete(entityViews)
            .where(
              and(
                eq(entityViews.id, params.viewId),
                viewOwner({
                  organizationId: session.activeOrganizationId,
                  userId: user.id,
                }),
              ),
            )
            .returning()
        ).at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.VIEW,
            resourceId: row.id,
          });
        }
        return row;
      }),
    );
    if (!removed) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }
    return Result.ok({});
  },
);
