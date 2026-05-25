import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const config = {
  permissions: { workspace: ["update"] },
} satisfies HandlerConfig;

const archiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const updated = await tx
          .update(workspaces)
          .set({ status: "archived" })
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.status, "active"),
            ),
          )
          .returning({ id: workspaces.id });

        // Clear lastActiveWorkspaceId for members pointing to this
        // workspace so they don't get redirected to an archived workspace.
        await tx
          .update(member)
          .set({ lastActiveWorkspaceId: null })
          .where(eq(member.lastActiveWorkspaceId, workspaceId));

        if (updated.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              status: { old: "active", new: "archived" },
            },
          });
        }
      }),
    );

    return Result.ok({ success: true as const });
  },
);

export default archiveWorkspace;
