import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { desktopEditSessions, workspaces } from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import {
  buildExpiryAuditEvents,
  selectTransitionedExpirableSessions,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-audit";
import {
  type ExpiredDesktopEditSessionNotification,
  publishDesktopEditSessionExpiryNotificationsWithRetry,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-notifications";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import {
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
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    const unnotifiedExpiredSessions = await rootDb
      .select({
        id: desktopEditSessions.id,
        workspaceId: desktopEditSessions.workspaceId,
      })
      .from(desktopEditSessions)
      .where(
        and(
          eq(desktopEditSessions.status, "expired"),
          isNull(desktopEditSessions.expiryNotificationPublishedAt),
        ),
      )
      .orderBy(asc(desktopEditSessions.closedAt))
      .limit(EXPIRE_SWEEP_BATCH_SIZE);

    await publishAndMarkExpiryNotifications(unnotifiedExpiredSessions);

    if (unnotifiedExpiredSessions.length === EXPIRE_SWEEP_BATCH_SIZE) {
      continue;
    }

    // Mirror authorizeDesktopEditSession's liveness check: a session past
    // tokenExpiresAt has no connected desktop stream refreshing it.
    const now = new Date();
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
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

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one transition per swept page
    const expiredSessions = await rootDb.transaction(async (tx) => {
      const transitioned = await tx
        .update(desktopEditSessions)
        .set({
          status: "expired",
          closedAt: now,
        })
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
      const auditEventsByActor = new Map<
        string,
        (typeof auditEvents)[number][]
      >();
      for (const auditEvent of auditEvents) {
        const key = `${auditEvent.organizationId}\0${auditEvent.userId}`;
        const actorEvents = auditEventsByActor.get(key);
        if (actorEvents) {
          actorEvents.push(auditEvent);
        } else {
          auditEventsByActor.set(key, [auditEvent]);
        }
      }
      for (const actorEvents of auditEventsByActor.values()) {
        const firstEvent = actorEvents.at(0);
        if (!firstEvent) {
          panic("Desktop edit expiry audit group must not be empty");
        }
        const recordAuditEvent = createBackgroundAuditRecorder({
          execution: {
            performer: {
              id: "desktop-edit-session-expiry",
              name: "Desktop edit session expiry",
              type: "service",
            },
            trigger: {
              source: "desktop-edit-session-expiry",
              type: "system",
            },
          },
          organizationId: firstEvent.organizationId,
          workspaceId: null,
          userId: firstEvent.userId,
        });
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one batched audit insert per actor; the recorder binds organization and user
        await recordAuditEvent(
          tx,
          actorEvents.map(({ event }) => event),
        );
      }

      return selectTransitionedExpirableSessions(batch, expiredIds);
    });

    expired += expiredSessions.length;
    await publishAndMarkExpiryNotifications(expiredSessions);

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

const publishAndMarkExpiryNotifications = async (
  sessions: ExpiredDesktopEditSessionNotification[],
): Promise<void> => {
  if (sessions.length === 0) {
    return;
  }

  await publishDesktopEditSessionExpiryNotificationsWithRetry({
    publisher: { publishSessionEvent, publishWorkspaceEvent },
    sessions,
  });

  await rootDb
    .update(desktopEditSessions)
    .set({ expiryNotificationPublishedAt: new Date() })
    .where(
      and(
        inArray(
          desktopEditSessions.id,
          sessions.map((session) => session.id),
        ),
        eq(desktopEditSessions.status, "expired"),
        isNull(desktopEditSessions.expiryNotificationPublishedAt),
      ),
    );
};
