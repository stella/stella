import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const config = {
  permissions: { workspace: ["update"] },
} satisfies HandlerConfig;

const unarchiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const updated = await tx
          .update(workspaces)
          .set({ status: "active" })
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.status, "archived"),
            ),
          )
          .returning({ id: workspaces.id });

        if (updated.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              status: { old: "archived", new: "active" },
            },
          });
        }
      }),
    );

    return Result.ok({ success: true as const });
  },
);

export default unarchiveWorkspace;
