import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "covered", by: "save_matter" },
} satisfies HandlerConfig;

export type ArchiveWorkspaceHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
};

// Shared matter-archive logic reused by the HTTP handler and the
// `save_matter` MCP tool, so both emit identical audit events.
export const archiveWorkspaceHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
}: ArchiveWorkspaceHandlerProps) {
  yield* Result.await(
    safeDb(async (tx) => {
      const updated = await tx
        .update(workspaces)
        .set({ status: "archived" })
        .where(
          and(eq(workspaces.id, workspaceId), eq(workspaces.status, "active")),
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
};

const archiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, recordAuditEvent }) {
    return yield* archiveWorkspaceHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
    });
  },
);

export default archiveWorkspace;
