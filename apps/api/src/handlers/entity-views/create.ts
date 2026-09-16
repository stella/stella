import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { entityViews } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  entityViewBody,
  response,
  validateEntityViewLayout,
  viewOwner,
} from "./shared";

const config = {
  description:
    "Save a personal Table or Kanban view across accessible matters. Layout filters and sorts use the same contract as matter views.",
  permissions: { view: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: entityViewBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const layout = validateEntityViewLayout(body.layout);
    if (layout.isErr()) {
      return Result.err(layout.error);
    }
    const created = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize the bounded list and insertion across tabs and API replicas.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${user.id}))`,
        );
        const existing = await tx
          .select({ position: entityViews.position })
          .from(entityViews)
          .where(
            viewOwner({
              organizationId: session.activeOrganizationId,
              userId: user.id,
            }),
          )
          .limit(LIMITS.viewsCount);
        if (existing.length >= LIMITS.viewsCount) {
          return null;
        }
        let highestPosition = -1;
        for (const view of existing) {
          highestPosition = Math.max(highestPosition, view.position);
        }
        const rows = await tx
          .insert(entityViews)
          .values({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            name: body.name.trim(),
            layout: layout.value,
            position: highestPosition + 1,
          })
          .returning();
        const row = rows.at(0) ?? panic("View insert returned no row");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: row.id,
          changes: { layout: { old: null, new: row.layout } },
        });
        return row;
      }),
    );
    if (!created) {
      return Result.err(
        new HandlerError({ status: 400, message: "Views limit reached" }),
      );
    }
    return Result.ok(response(created));
  },
);
