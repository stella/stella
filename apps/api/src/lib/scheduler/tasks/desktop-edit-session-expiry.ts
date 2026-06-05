import { panic } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { auditLogs, desktopEditSessions, workspaces } from "@/api/db/schema";
import {
  closeSessionConnections,
  pushSessionEvent,
} from "@/api/handlers/entities/desktop-edit-session-events";
import { buildExpiryAuditEvents } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-audit";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { broadcast } from "@/api/lib/sse";

export const EXPIRE_DESKTOP_EDIT_SESSIONS_TASK =
  "desktopEditSessions.expire" as const;

/** Sweep in bounded batches so each transaction stays small. */
const EXPIRE_SWEEP_BATCH_SIZE = 200;

/**
 * Transition abandoned desktop edit sessions whose token TTL has lapsed
 * from "open" to "expired". The token already governs liveness
 * (`authorizeDesktopEditSession` rejects an expired token), but the row
 * stays "open" until something closes it: it keeps showing a lock in the
 * entities view and holds the partial unique index that blocks re-opening
 * the same file. This sweep is that "something".
 */
export const expireDesktopEditSessions: SchedulerTask = async ({
  logger,
  signal,
}) => {
  let expired = 0;

  while (!signal.aborted) {
    // Mirror authorizeDesktopEditSession's liveness check
    // (tokenExpiresAt < now): a session past its token TTL is already
    // unusable for edits, so the lock it implies is stale.
    const now = new Date();
    const batch = await rootDb
      .select({
        id: desktopEditSessions.id,
        workspaceId: desktopEditSessions.workspaceId,
        createdBy: desktopEditSessions.createdBy,
        organizationId: workspaces.organizationId,
      })
      .from(desktopEditSessions)
      .innerJoin(workspaces, eq(workspaces.id, desktopEditSessions.workspaceId))
      .where(
        and(
          eq(desktopEditSessions.status, "open"),
          lt(desktopEditSessions.tokenExpiresAt, now),
        ),
      )
      .orderBy(asc(desktopEditSessions.tokenExpiresAt))
      .limit(EXPIRE_SWEEP_BATCH_SIZE);

    if (batch.length === 0) {
      break;
    }

    const batchIds = batch.map((session) => session.id);

    const expiredSessions = await rootDb.transaction(async (tx) => {
      const transitioned = await tx
        .update(desktopEditSessions)
        .set({ status: "expired", closedAt: now })
        .where(
          and(
            inArray(desktopEditSessions.id, batchIds),
            eq(desktopEditSessions.status, "open"),
            // Re-check expiry inside the UPDATE: a checkpoint or resume can
            // extend tokenExpiresAt between the SELECT and here, renewing the
            // session. Without this guard we would expire a freshly-renewed
            // active session and close the editor.
            lt(desktopEditSessions.tokenExpiresAt, now),
          ),
        )
        .returning({ id: desktopEditSessions.id });

      const expiredIds = new Set(transitioned.map((row) => row.id));
      const auditEvents = buildExpiryAuditEvents(batch, expiredIds);
      if (auditEvents.length > 0) {
        await tx.insert(auditLogs).values(auditEvents);
      }

      return batch.filter((session) => expiredIds.has(session.id));
    });

    // Post-commit, cross-instance side effects, mirroring
    // release-desktop-edit-lock: tell desktop SSE streams the session is
    // gone and nudge open entities views to refetch, so the lock clears
    // for active clients instead of lingering until an unrelated refetch.
    for (const session of expiredSessions) {
      pushSessionEvent(session.id, {
        type: "session-closed",
        data: { reason: "expired" },
      });
      closeSessionConnections(session.id);
    }
    for (const workspaceId of new Set(
      expiredSessions.map((session) => session.workspaceId),
    )) {
      broadcast(workspaceId, {
        type: "invalidate-query",
        data: ["entities", workspaceId],
      });
    }

    expired += expiredSessions.length;

    if (batch.length < EXPIRE_SWEEP_BATCH_SIZE) {
      break;
    }
  }

  logger.info("scheduler.desktop_edit_sessions_expired", {
    "desktopEditSessions.expired": expired,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }
};
