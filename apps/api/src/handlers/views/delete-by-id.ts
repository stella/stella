import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { views } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
      .select({ id: views.id })
      .from(views)
      .where(eq(views.workspaceId, workspaceId))
      .for("update");

    if (!lockedViews.some((v) => v.id === viewId)) {
      return status(404, { message: "View not found" });
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
