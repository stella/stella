import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceContacts } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const config = {
  permissions: { workspace: ["update"] },
  params: t.Object({ workspaceContactId: tNanoid }),
} satisfies HandlerConfig;

const deleteWorkspaceContact = createHandler(
  config,
  async ({ scopedDb, workspaceId, params: { workspaceContactId } }) => {
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
  },
);

export default deleteWorkspaceContact;
