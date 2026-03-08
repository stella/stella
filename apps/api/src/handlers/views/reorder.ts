import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { views } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const reorderViewsBodySchema = t.Object({
  viewIds: t.Array(tNanoid, { minItems: 1 }),
});

type ReorderViewsBodySchema = Static<typeof reorderViewsBodySchema>;

type ReorderViewsHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: ReorderViewsBodySchema;
};

export const reorderViewsHandler = ({
  workspaceId,
  body,
}: ReorderViewsHandlerProps) => {
  return db.transaction(async (tx) => {
    // Lock rows and validate all viewIds exist before updating
    const lockedViews = await tx
      .select({ id: views.id })
      .from(views)
      .where(eq(views.workspaceId, workspaceId))
      .for("update");

    const uniqueViewIds = new Set(body.viewIds);
    if (uniqueViewIds.size !== body.viewIds.length) {
      return status(400, {
        message: "Duplicate view IDs in reorder list",
      });
    }

    const existingIds = new Set(lockedViews.map((v) => v.id));
    const allExist = body.viewIds.every((id) => existingIds.has(id));

    if (!allExist || body.viewIds.length !== lockedViews.length) {
      return status(400, {
        message: "View IDs must include all views in the workspace",
      });
    }

    await Promise.all(
      body.viewIds.map((viewId, index) =>
        tx
          .update(views)
          .set({ position: index })
          .where(and(eq(views.id, viewId), eq(views.workspaceId, workspaceId))),
      ),
    );

    return;
  });
};
