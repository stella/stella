import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { workspaceContacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteWorkspaceContactHandlerProps = {
  workspaceId: SafeId<"workspace">;
  workspaceContactId: string;
};

export const deleteWorkspaceContactHandler = async ({
  workspaceId,
  workspaceContactId,
}: DeleteWorkspaceContactHandlerProps) => {
  const [deleted] = await db
    .delete(workspaceContacts)
    .where(
      and(
        eq(workspaceContacts.id, workspaceContactId),
        eq(workspaceContacts.workspaceId, workspaceId),
      ),
    )
    .returning({ id: workspaceContacts.id });

  if (!deleted) {
    return status(404, { message: "Party not found" });
  }

  return { id: deleted.id };
};
