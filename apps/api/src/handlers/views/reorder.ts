import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  resourceRef,
  RESOURCE_TYPE,
  resourceUpdatedChange,
} from "@stll/api-contract";

import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditEvent } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { broadcastWorkspaceResourceChanges } from "@/api/lib/resource-realtime";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

const config = {
  description:
    "Set the tab order of a matter's views. viewIds must name every view of " +
    "the matter exactly once in the order you want; a partial list, an " +
    "unknown id, or a duplicate is refused. Only positions change.",
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: t.Object({
    viewIds: t.Array(tSafeId("workspaceView"), {
      minItems: 1,
      maxItems: LIMITS.viewsCount,
    }),
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
    // The THEN branch needs an explicit cast: without it, Postgres can't
    // resolve the untyped bound parameter against the CASE's overall type
    // and rejects the assignment to the integer `position` column.
    const cases = viewIds.map(
      (id, i) => sql`when ${workspaceViews.id} = ${id} then ${i}::integer`,
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
            position: sqlCaseFragment({
              branches: cases,
              // Every view in the workspace is validated to be in `viewIds`
              // above, so the ELSE renders but never evaluates.
              fallback: sql`${workspaceViews.position}`,
            }),
          })
          .where(eq(workspaceViews.workspaceId, workspaceId));

        await recordAuditEvent(tx, movedEvents);
      }),
    );

    broadcastWorkspaceResourceChanges(
      workspaceId,
      viewIds.map((id) =>
        resourceUpdatedChange(
          resourceRef({ type: RESOURCE_TYPE.WORKSPACE_VIEW, id }),
        ),
      ),
    );

    return Result.ok({});
  },
);

export default reorderViews;
