import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";
import { REQUIRED_VIEW_LAYOUTS } from "@/api/lib/views";

const config = {
  permissions: { view: ["delete"] },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
} satisfies HandlerConfig;

const deleteView = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params: { viewId } }) {
    const allViews = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: workspaceViews.id,
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

    const targetLayoutType = target.layoutType.type;
    if (REQUIRED_VIEW_LAYOUTS.includes(targetLayoutType)) {
      const sameLayoutCount = allViews.filter(
        (v) => v.layoutType.type === targetLayoutType,
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
      safeDb((tx) =>
        tx
          .delete(workspaceViews)
          .where(
            and(
              eq(workspaceViews.id, viewId),
              eq(workspaceViews.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok(undefined);
  },
);

export default deleteView;
