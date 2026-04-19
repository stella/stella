import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["update"] },
} satisfies HandlerConfig;

const archiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(workspaces)
          .set({ status: "archived" })
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.status, "active"),
            ),
          );

        // Clear lastActiveWorkspaceId for members pointing to this
        // workspace so they don't get redirected to an archived workspace.
        await tx
          .update(member)
          .set({ lastActiveWorkspaceId: null })
          .where(eq(member.lastActiveWorkspaceId, workspaceId));
      }),
    );

    return Result.ok({ success: true as const });
  },
);

export default archiveWorkspace;
