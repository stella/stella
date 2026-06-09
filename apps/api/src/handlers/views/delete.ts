import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";
import { REQUIRED_VIEW_LAYOUTS } from "@/api/lib/views";
import { parseViewLayout } from "@/api/lib/views-schema";

const config = {
  permissions: { view: ["delete"] },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
} satisfies HandlerConfig;

const deleteView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params: { viewId },
    recordAuditEvent,
  }) {
    const allViews = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: workspaceViews.id,
            name: workspaceViews.name,
            layoutType: workspaceViews.layout,
          })
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId))
          .for("update"),
      ),
    );

    if (allViews.length <= 1) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot delete the last view",
        }),
      );
    }

    const target = allViews.find((v) => v.id === viewId);
    if (!target) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }

    const targetLayoutType = parseViewLayout(target.layoutType).type;
    if (REQUIRED_VIEW_LAYOUTS.includes(targetLayoutType)) {
      const sameLayoutCount = allViews.filter(
        (v) => parseViewLayout(v.layoutType).type === targetLayoutType,
      ).length;

      if (sameLayoutCount <= 1) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `Cannot delete the last ${targetLayoutType} view`,
          }),
        );
      }
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(workspaceViews)
          .where(
            and(
              eq(workspaceViews.id, viewId),
              eq(workspaceViews.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: viewId,
          changes: {
            deleted: {
              old: { name: target.name, layoutType: targetLayoutType },
              new: null,
            },
          },
        });
      }),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok({});
  },
);

export default deleteView;
