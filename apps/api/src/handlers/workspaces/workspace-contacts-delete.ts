import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { workspaceContacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteWorkspaceContactHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  workspaceContactId: string;
};

export const deleteWorkspaceContactHandler = async ({
  scopedDb,
  workspaceId,
  workspaceContactId,
}: DeleteWorkspaceContactHandlerProps) => {
  const deletedRows = await scopedDb((tx) =>
    tx
      .delete(workspaceContacts)
      .where(
        and(
          eq(workspaceContacts.id, workspaceContactId),
          eq(workspaceContacts.workspaceId, workspaceId),
        ),
      )
      .returning({ id: workspaceContacts.id }),
  );
  const deleted = deletedRows.at(0);

  if (!deleted) {
    return status(404, { message: "Party not found" });
  }

  return { id: deleted.id };
};
