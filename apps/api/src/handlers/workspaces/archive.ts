import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { documentProcessingRuns, workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      // Lock the workspace before inspecting dispatches. OCR takes this same
      // lock immediately before it claims a run, so archive cannot race a
      // provider dispatch after the workspace becomes read-only.
      const workspaceRows = await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      const workspace = workspaceRows.at(0);
      if (workspace?.status === "active") {
        const runningOcrRuns = await tx
          .select({ id: documentProcessingRuns.id })
          .from(documentProcessingRuns)
          .where(
            and(
              eq(documentProcessingRuns.workspaceId, workspaceId),
              eq(documentProcessingRuns.status, "running"),
            ),
          )
          .limit(1);
        if (runningOcrRuns.at(0)) {
          return "document_processing_running" as const;
        }
      }

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
      return "archived" as const;
    }),
  );

  if (outcome === "document_processing_running") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Wait for document processing to finish before archiving",
      }),
    );
  }

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
