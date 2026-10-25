import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import {
  bufferObjectCleanupIntents,
  desktopEditSessions,
  workspaces,
} from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  buildExpiryAuditEvents,
  selectTransitionedExpirableSessions,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-audit";
import { buildDesktopEditCheckpointCleanupIntents } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-cleanup";
import {
  type DesktopEditSessionExpiryNotificationPublisher,
  type ExpiredDesktopEditSessionNotification,
  publishDesktopEditSessionExpiryNotificationsWithRetry,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-notifications";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import {
  publishSessionEvent,
  publishWorkspaceEvent,
} from "@/api/lib/sse-broadcast";

export const EXPIRE_DESKTOP_EDIT_SESSIONS_TASK =
  "desktopEditSessions.expire" as const;

/** Sweep in bounded batches so each transaction stays small. */
const EXPIRE_SWEEP_BATCH_SIZE = 200;

type DesktopEditSessionExpiryDependencies = {
  publisher?: DesktopEditSessionExpiryNotificationPublisher;
};

const defaultPublisher = { publishSessionEvent, publishWorkspaceEvent };

/**
 * Transition abandoned desktop edit sessions whose liveness TTL has lapsed
 * from "open" to "expired". Live desktop event streams refresh the TTL, and
 * `authorizeDesktopEditSession` rejects expired tokens. Once nothing has
 * refreshed a session within the TTL, the row still stays "open" until
 * something closes it: it keeps holding the partial unique index that blocks
 * re-opening the same file. This sweep is that "something".
 */
export const expireDesktopEditSessions = async (
  { db, logger, signal }: SchedulerTaskContext,
  { publisher = defaultPublisher }: DesktopEditSessionExpiryDependencies = {},
): Promise<void> => {
  let expired = 0;

  while (!signal.aborted) {
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const unnotifiedExpiredSessions = await db
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

    // db-await-in-loop: page loop: one batched publish per page of sessions
    await publishAndMarkExpiryNotifications(
      db,
      unnotifiedExpiredSessions,
      publisher,
    );

    if (unnotifiedExpiredSessions.length === EXPIRE_SWEEP_BATCH_SIZE) {
      continue;
    }

    // Mirror authorizeDesktopEditSession's liveness check: a session past
    // tokenExpiresAt has no connected desktop stream refreshing it.
    const now = new Date();
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const batch = await db
      .select({
        checkpointFileId: desktopEditSessions.checkpointFileId,
        checkpointSizeBytes: desktopEditSessions.checkpointSizeBytes,
        fileType: desktopEditSessions.fileType,
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

    // db-await-in-loop: one transition per swept page
    const expiredSessions = await withAggregateTransaction(db, async (tx) => {
      const transitioned = await tx
        .update(desktopEditSessions)
        .set({
          checkpointScanWarnings: null,
          checkpointSha256Hex: null,
          checkpointSizeBytes: null,
          checkpointUpdatedAt: null,
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
        // The checkpoint the transition clears, read from the row it locked:
        // one committed after the batch read is still owned by its intent.
        .returning({
          id: desktopEditSessions.id,
          checkpointFileId: sql<
            typeof desktopEditSessions.$inferSelect.checkpointFileId
          >`old.checkpoint_file_id`,
          checkpointSizeBytes: sql<number | null>`old.checkpoint_size_bytes`,
          fileType: desktopEditSessions.fileType,
          workspaceId: desktopEditSessions.workspaceId,
        });

      const expiredIds = new Set(transitioned.map((row) => row.id));
      const organizationBySession = new Map(
        batch.map((row) => [row.id, row.organizationId]),
      );
      const cleanupIntents = buildDesktopEditCheckpointCleanupIntents({
        now,
        sessions: transitioned.map((session) => ({
          ...session,
          organizationId:
            organizationBySession.get(session.id) ??
            panic("Expired desktop edit session left its batch"),
        })),
      });
      if (cleanupIntents.length > 0) {
        // audit: skip; exact-key cleanup is atomically owned by the audited
        // open-to-expired transition and retried by the cleanup scheduler.
        await tx.insert(bufferObjectCleanupIntents).values(cleanupIntents);
      }
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
        // db-await-in-loop: one batched audit insert per actor; the recorder binds organization and user
        await recordAuditEvent(
          tx,
          actorEvents.map(({ event }) => event),
        );
      }

      return selectTransitionedExpirableSessions(batch, expiredIds);
    });

    expired += expiredSessions.length;
    // db-await-in-loop: page loop: one batched publish per page of sessions
    await publishAndMarkExpiryNotifications(db, expiredSessions, publisher);

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
  db: SchedulerDb,
  sessions: ExpiredDesktopEditSessionNotification[],
  publisher: DesktopEditSessionExpiryNotificationPublisher,
): Promise<void> => {
  if (sessions.length === 0) {
    return;
  }

  await publishDesktopEditSessionExpiryNotificationsWithRetry({
    publisher,
    sessions,
  });

  await db
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
