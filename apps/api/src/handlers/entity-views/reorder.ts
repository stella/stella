import { Result } from "better-result";
import { sql } from "drizzle-orm";

import { entityViews } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

import { entityViewReorderBody, viewOwner } from "./shared";

const config = {
  description:
    "Reorder every personal cross-matter view. Supply each of the user's view IDs exactly once.",
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: entityViewReorderBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({
    body: { viewIds },
    safeDb,
    session,
    user,
    recordAuditEvent,
  }) {
    if (new Set(viewIds).size !== viewIds.length) {
      return Result.err(
        new HandlerError({ status: 400, message: "Duplicate view IDs" }),
      );
    }
    const changed = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${user.id}))`,
        );
        const where = viewOwner({
          organizationId: session.activeOrganizationId,
          userId: user.id,
        });
        const existing = await tx
          .select({ id: entityViews.id, position: entityViews.position })
          .from(entityViews)
          .where(where)
          .limit(LIMITS.viewsCount);
        const ids = new Set(existing.map((row) => row.id));
        if (
          existing.length !== viewIds.length ||
          viewIds.some((id) => !ids.has(id))
        ) {
          return false;
        }
        await tx
          .update(entityViews)
          .set({
            position: sqlCaseFragment({
              branches: viewIds.map(
                (id, index) =>
                  sql`when ${entityViews.id} = ${id} then ${index}::integer`,
              ),
              fallback: sql`${entityViews.position}`,
            }),
            updatedAt: new Date(),
          })
          .where(where);
        await recordAuditEvent(
          tx,
          existing.flatMap((row) => {
            const next = viewIds.indexOf(row.id);
            if (next === row.position) {
              return [];
            }
            return [
              {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.VIEW,
                resourceId: row.id,
                changes: { position: { old: row.position, new: next } },
              },
            ];
          }),
        );
        return true;
      }),
    );
    if (!changed) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Supply every saved view exactly once",
        }),
      );
    }
    return Result.ok({});
  },
);
