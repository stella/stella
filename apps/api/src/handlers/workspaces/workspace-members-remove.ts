import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { workspaceMembers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type RemoveWorkspaceMemberHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: string;
};

export const removeWorkspaceMemberHandler = async ({
  scopedDb,
  workspaceId,
  userId,
}: RemoveWorkspaceMemberHandlerProps) => {
  // Lock + delete in one transaction to prevent TOCTOU.
  // FOR UPDATE on the row select (not aggregate) locks
  // member rows so concurrent removals serialize.
  const result = await scopedDb(async (tx) => {
    const lockedRows = await tx
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .for("update");

    // Check membership before the count guard so a non-member
    // gets 404, not 400 "last member".
    if (!lockedRows.some((r) => r.userId === userId)) {
      return { error: "not-found" as const };
    }

    if (lockedRows.length <= 1) {
      return { error: "last-member" as const };
    }

    const deleteResult = await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning({ id: workspaceMembers.id });
    const deleted = deleteResult.at(0);

    if (!deleted) {
      return { error: "not-found" as const };
    }

    return { id: deleted.id };
  });

  if ("error" in result) {
    if (result.error === "last-member") {
      return status(400, {
        message: "Cannot remove the last workspace member",
      });
    }
    return status(404, { message: "Member not found" });
  }

  return { id: result.id };
};
