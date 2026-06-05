import { panic } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { auditLogs, desktopEditSessions, workspaces } from "@/api/db/schema";
import { buildExpiryAuditEvents } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-audit";
import { publishDesktopEditSessionExpiryNotifications } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-notifications";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import {
  ensureCrossInstanceBroadcastReady,
  publishSessionEvent,
  publishWorkspaceEvent,
} from "@/api/lib/sse-broadcast";

export const EXPIRE_DESKTOP_EDIT_SESSIONS_TASK =
  "desktopEditSessions.expire" as const;

/** Sweep in bounded batches so each transaction stays small. */
const EXPIRE_SWEEP_BATCH_SIZE = 200;

/**
 * Transition abandoned desktop edit sessions whose liveness TTL has lapsed
 * from "open" to "expired". Live desktop event streams refresh the TTL, and
 * `authorizeDesktopEditSession` rejects expired tokens. Once nothing has
 * refreshed a session within the TTL, the row still stays "open" until
 * something closes it: it keeps holding the partial unique index that blocks
 * re-opening the same file. This sweep is that "something".
 */
export const expireDesktopEditSessions: SchedulerTask = async ({
  logger,
  signal,
}) => {
  let expired = 0;

  while (!signal.aborted) {
    // Mirror authorizeDesktopEditSession's liveness check: a session past
    // tokenExpiresAt has no connected desktop stream refreshing it.
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

    // The scheduler is a separate process from the API instances that hold
    // desktop SSE streams, so its expiry side effects must go through Redis.
    await ensureCrossInstanceBroadcastReady();

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

    await publishDesktopEditSessionExpiryNotifications({
      publisher: { publishSessionEvent, publishWorkspaceEvent },
      sessions: expiredSessions,
    });

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
