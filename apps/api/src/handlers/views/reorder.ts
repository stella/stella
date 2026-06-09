import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditEvent } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { view: ["update"] },
  body: t.Object({
    viewIds: t.Array(tSafeId("workspaceView"), { minItems: 1 }),
  }),
} satisfies HandlerConfig;

const reorderViews = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body: { viewIds },
    recordAuditEvent,
  }) {
    if (new Set(viewIds).size !== viewIds.length) {
      return Result.err(
        new HandlerError({ status: 400, message: "Duplicate view IDs" }),
      );
    }

    // Validate before mutating: check that all supplied IDs
    // match the existing views in this workspace.
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: workspaceViews.id,
            position: workspaceViews.position,
          })
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId)),
      ),
    );

    if (viewIds.length !== existing.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "View IDs must include all views in the workspace",
        }),
      );
    }

    const existingIds = new Set(existing.map((v) => v.id));
    for (const id of viewIds) {
      if (!existingIds.has(id)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "View IDs must include all views in the workspace",
          }),
        );
      }
    }

    // Build a single CASE expression to update all positions at once.
    const cases = viewIds.map(
      (id, i) => sql`when ${workspaceViews.id} = ${id} then ${i}`,
    );

    const oldPositionById = new Map(existing.map((v) => [v.id, v.position]));
    const movedEvents: AuditEvent[] = [];
    for (const [i, id] of viewIds.entries()) {
      const oldPosition = oldPositionById.get(id);
      if (oldPosition !== undefined && oldPosition !== i) {
        movedEvents.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: id,
          changes: { position: { old: oldPosition, new: i } },
          metadata: { reason: "reorder" },
        });
      }
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(workspaceViews)
          .set({
            position: sql`case ${sql.join(cases, sql` `)} end`,
          })
          .where(eq(workspaceViews.workspaceId, workspaceId));

        await recordAuditEvent(tx, movedEvents);
      }),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok({});
  },
);

export default reorderViews;
