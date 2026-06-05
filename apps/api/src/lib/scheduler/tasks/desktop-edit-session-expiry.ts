import { panic } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { auditLogs, desktopEditSessions, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const EXPIRE_DESKTOP_EDIT_SESSIONS_TASK =
  "desktopEditSessions.expire" as const;

/** Sweep in bounded batches so each transaction stays small. */
const EXPIRE_SWEEP_BATCH_SIZE = 200;

type ExpirableSession = {
  id: string;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  createdBy: string;
};

type ExpiryAuditEvent = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
  action: typeof AUDIT_ACTION.UPDATE;
  resourceType: typeof AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION;
  resourceId: string;
  changes: { status: { old: "open"; new: "expired" } };
  metadata: { reason: "token_expired" };
};

/**
 * A row can leave "open" between the SELECT and the UPDATE (a concurrent
 * finalize or takeover), so the ids the UPDATE actually transitioned are
 * the source of truth for what to audit, not the originally selected batch.
 */
export const buildExpiryAuditEvents = (
  sessions: readonly ExpirableSession[],
  expiredIds: ReadonlySet<string>,
): ExpiryAuditEvent[] =>
  sessions
    .filter((session) => expiredIds.has(session.id))
    .map((session) => ({
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      userId: session.createdBy,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
      resourceId: session.id,
      changes: { status: { old: "open", new: "expired" } },
      metadata: { reason: "token_expired" },
    }));

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

    const sweptCount = await rootDb.transaction(async (tx) => {
      const transitioned = await tx
        .update(desktopEditSessions)
        .set({ status: "expired", closedAt: now })
        .where(
          and(
            inArray(desktopEditSessions.id, batchIds),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .returning({ id: desktopEditSessions.id });

      const expiredIds = new Set(transitioned.map((row) => row.id));
      const auditEvents = buildExpiryAuditEvents(batch, expiredIds);
      if (auditEvents.length > 0) {
        await tx.insert(auditLogs).values(auditEvents);
      }

      return transitioned.length;
    });

    expired += sweptCount;

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
