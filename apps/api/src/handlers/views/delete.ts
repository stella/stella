import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceViews } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { broadcast } from "@/api/lib/sse";
import { REQUIRED_VIEW_LAYOUTS } from "@/api/lib/views";

const config = {
  permissions: { view: ["delete"] },
  params: t.Object({
    viewId: tNanoid,
  }),
} satisfies HandlerConfig;

const deleteView = createHandler(
  config,
  async ({ scopedDb, workspaceId, params: { viewId } }) => {
    const allViews = await scopedDb((tx) =>
      tx
        .select({
          id: workspaceViews.id,
          layoutType: workspaceViews.layout,
        })
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, workspaceId))
        .for("update"),
    );

    if (allViews.length <= 1) {
      return status(400, { message: "Cannot delete the last view" });
    }

    const target = allViews.find((v) => v.id === viewId);
    if (!target) {
      return status(404, { message: "View not found" });
    }

    const targetLayoutType = target.layoutType.type;
    if (REQUIRED_VIEW_LAYOUTS.includes(targetLayoutType)) {
      const sameLayoutCount = allViews.filter(
        (v) => v.layoutType.type === targetLayoutType,
      ).length;

      if (sameLayoutCount <= 1) {
        return status(400, {
          message: `Cannot delete the last ${targetLayoutType} view`,
        });
      }
    }

    await scopedDb((tx) =>
      tx
        .delete(workspaceViews)
        .where(
          and(
            eq(workspaceViews.id, viewId),
            eq(workspaceViews.workspaceId, workspaceId),
          ),
        ),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return undefined;
  },
);

export default deleteView;
