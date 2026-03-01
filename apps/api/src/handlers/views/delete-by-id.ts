import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { views } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { REQUIRED_VIEW_LAYOUT_SET } from "@/api/lib/views";

type DeleteViewHandlerProps = {
  viewId: string;
  workspaceId: SafeId<"workspace">;
};

export const deleteViewHandler = ({
  viewId,
  workspaceId,
}: DeleteViewHandlerProps) => {
  return db.transaction(async (tx) => {
    const lockedViews = await tx
      .select({ id: views.id, layout: views.layout })
      .from(views)
      .where(eq(views.workspaceId, workspaceId))
      .for("update");

    const target = lockedViews.find((v) => v.id === viewId);

    if (!target) {
      return status(404, { message: "View not found" });
    }

    const isRequired = REQUIRED_VIEW_LAYOUT_SET.has(target.layout);

    if (isRequired) {
      const sameLayoutCount = lockedViews.filter(
        (v) => v.layout === target.layout,
      ).length;

      if (sameLayoutCount <= 1) {
        return status(400, {
          message: `Cannot delete the last ${target.layout} view`,
        });
      }
    }

    if (lockedViews.length <= 1) {
      return status(400, {
        message: "Cannot delete the last view",
      });
    }

    await tx
      .delete(views)
      .where(and(eq(views.id, viewId), eq(views.workspaceId, workspaceId)));

    return undefined;
  });
};
