import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceMembers } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["update"] },
  params: t.Object({
    userId: t.String({ maxLength: 128 }),
  }),
} satisfies HandlerConfig;

const removeWorkspaceMember = createHandler(
  config,
  async ({ scopedDb, workspaceId, params: { userId } }) => {
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
  },
);

export default removeWorkspaceMember;
