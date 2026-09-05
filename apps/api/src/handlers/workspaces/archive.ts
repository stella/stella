import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Archive a matter: it stops being writable and is cleared from members' " +
    "last-visited matter. Reversible with matters.unarchive, and nothing " +
    "is deleted. Refused while document processing is running in the matter " +
    "or any timer is still running there.",
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
      // Timer starts take this advisory lock before inserting. Acquire it
      // before the workspace row lock to keep lock ordering acyclic, then hold
      // it through the active-timer check so archive cannot strand a timer
      // that starts concurrently.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
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

        const runningTimers = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              isNotNull(timeEntries.timerStartedAt),
            ),
          )
          .limit(1);
        if (runningTimers.at(0)) {
          return "timer_running" as const;
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

  if (outcome === "timer_running") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Stop active timers before archiving this matter",
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
