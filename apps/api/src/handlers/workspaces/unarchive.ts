import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
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

export type UnarchiveWorkspaceHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
};

// Shared matter-unarchive logic reused by the HTTP handler and the
// `save_matter` MCP tool, so both emit identical audit events.
export const unarchiveWorkspaceHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
}: UnarchiveWorkspaceHandlerProps) {
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
};

const unarchiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, recordAuditEvent }) {
    return yield* unarchiveWorkspaceHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
    });
  },
);

export default unarchiveWorkspace;
