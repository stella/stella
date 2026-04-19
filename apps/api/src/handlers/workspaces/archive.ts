import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["update"] },
} satisfies HandlerConfig;

const archiveWorkspace = createHandler(
  config,
  async ({ scopedDb, workspaceId }) =>
    await scopedDb(async (tx) => {
      await tx
        .update(workspaces)
        .set({ status: "archived" })
        .where(
          and(eq(workspaces.id, workspaceId), eq(workspaces.status, "active")),
        );

      // Clear lastActiveWorkspaceId for members pointing to this
      // workspace so they don't get redirected to an archived workspace.
      await tx
        .update(member)
        .set({ lastActiveWorkspaceId: null })
        .where(eq(member.lastActiveWorkspaceId, workspaceId));

      return { success: true as const };
    }),
);

export default archiveWorkspace;
