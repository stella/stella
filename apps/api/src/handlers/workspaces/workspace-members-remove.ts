import { Result } from "better-result";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  timeEntries,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tUserId, workspaceParams } from "@/api/lib/custom-schema";
import {
  closeSessionConnections,
  pushSessionEvent,
} from "@/api/lib/desktop-edit-session-notifications";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { broadcastWorkspaceResourceSetUpdated } from "@/api/lib/resource-realtime";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { revokeWorkspaceSseAccess } from "@/api/lib/sse";

const config = {
  description:
    "Remove one member from a matter, revoking their live access and " +
    "cancelling their open desktop editing sessions. Their active work " +
    "obligations are unassigned rather than deleted; refused when they are the " +
    "matter's last member, when a timer of theirs is still running, or when " +
    "they own more work obligations than one call may unassign at once.",
  permissions: { workspace: ["update"] },
  mcp: { type: "covered", by: "manage_organization" },
  params: workspaceParams({ userId: tUserId }),
} satisfies HandlerConfig;

export type RemoveWorkspaceMemberProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  actorUserId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  dependencies?: RemoveWorkspaceMemberDependencies | undefined;
};

export type RemoveWorkspaceMemberDependencies = {
  broadcastWorkspaceResourceSetUpdated: typeof broadcastWorkspaceResourceSetUpdated;
  closeSessionConnections: typeof closeSessionConnections;
  pushSessionEvent: typeof pushSessionEvent;
  revokeWorkspaceSseAccess: typeof revokeWorkspaceSseAccess;
};

const defaultRemoveWorkspaceMemberDependencies = {
  broadcastWorkspaceResourceSetUpdated,
  closeSessionConnections,
  pushSessionEvent,
  revokeWorkspaceSseAccess,
} satisfies RemoveWorkspaceMemberDependencies;

// Shared remove-member logic reused by the HTTP handler and the
// `manage_organization` MCP tool. Keeps the tx (last-member guard, lead
// clear, desktop-edit session cancel, audit events) and the in-process SSE
// dispatch together so member removal has identical side effects on both
// transports.
export const removeWorkspaceMemberHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  actorUserId,
  recordAuditEvent,
  dependencies = defaultRemoveWorkspaceMemberDependencies,
}: RemoveWorkspaceMemberProps) {
  // Lock + delete in one transaction to prevent TOCTOU.
  // FOR UPDATE on the row select (not aggregate) locks
  // member rows so concurrent removals serialize.
  const txResult = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      // Timer starts take this lock before inserting. Hold it through the
      // active-timer check and member deletion so removal cannot strand a
      // timer that starts concurrently.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );

      const workspaceRows = await tx
        .select({ leadUserId: workspaces.leadUserId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");
      const workspace = workspaceRows.at(0);

      if (!workspace) {
        throw new HandlerError({ status: 404, message: "Member not found" });
      }

      const lockedRows = await tx
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .for("update");

      // Check membership before the count guard so a non-member
      // gets 404, not 400 "last member".
      if (!lockedRows.some((r) => r.userId === userId)) {
        throw new HandlerError({ status: 404, message: "Member not found" });
      }

      if (lockedRows.length <= 1) {
        throw new HandlerError({
          status: 400,
          message: "Cannot remove the last workspace member",
        });
      }

      const activeTimers = await tx
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.userId, userId),
            isNotNull(timeEntries.timerStartedAt),
            isNull(timeEntries.timerStoppedAt),
          ),
        )
        .limit(1)
        .for("update");

      if (activeTimers.at(0)) {
        throw new HandlerError({
          status: 409,
          message: "Stop the member's active timer before removing them",
        });
      }

      const ownedWork = await tx
        .select({
          entityId: workObligations.entityId,
          status: workObligations.status,
        })
        .from(workObligations)
        .where(
          and(
            eq(workObligations.workspaceId, workspaceId),
            eq(workObligations.ownerUserId, userId),
            inArray(workObligations.status, [
              WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
              WORK_OBLIGATION_STATUS.ACTIVE,
            ]),
          ),
        )
        .limit(LIMITS.workspaceMemberRemovalWorkObligationsMax + 1)
        .for("update");

      if (ownedWork.length > LIMITS.workspaceMemberRemovalWorkObligationsMax) {
        throw new HandlerError({
          status: 409,
          message: `Cannot remove a member with more than ${LIMITS.workspaceMemberRemovalWorkObligationsMax} owned work obligations. Reassign their work first.`,
        });
      }

      const deleteResult = await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .returning({ id: workspaceMembers.id });
      const deleted = deleteResult.at(0);

      if (!deleted) {
        throw new HandlerError({ status: 404, message: "Member not found" });
      }

      if (ownedWork.length > 0) {
        const activeEntityIds = ownedWork.map(({ entityId }) => entityId);
        const now = new Date();

        await tx
          .update(workObligations)
          .set({
            ownerUserId: null,
            status: WORK_OBLIGATION_STATUS.UNASSIGNED,
            acknowledgedAt: null,
            acknowledgedByUserId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workObligations.workspaceId, workspaceId),
              eq(workObligations.ownerUserId, userId),
              inArray(workObligations.entityId, activeEntityIds),
              inArray(workObligations.status, [
                WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
                WORK_OBLIGATION_STATUS.ACTIVE,
              ]),
            ),
          );

        const unassignmentEvents: (typeof workObligationEvents.$inferInsert)[] =
          [];
        for (const { entityId } of ownedWork) {
          unassignmentEvents.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: entityId,
            actorUserId,
            type: WORK_OBLIGATION_EVENT_TYPE.DELEGATED,
            details: {
              type: "ownership_changed",
              previousOwnerUserId: userId,
              nextOwnerUserId: null,
              cause: "owner_removed_from_workspace",
            },
            occurredAt: now,
          });
        }
        await tx.insert(workObligationEvents).values(unassignmentEvents);
      }

      const leadWasCleared = workspace.leadUserId === userId;
      if (leadWasCleared) {
        await tx
          .update(workspaces)
          .set({ leadUserId: null })
          .where(eq(workspaces.id, workspaceId));
      }

      const closedSessions = await tx
        .update(desktopEditSessions)
        .set({ status: "cancelled", closedAt: new Date() })
        .where(
          and(
            eq(desktopEditSessions.workspaceId, workspaceId),
            eq(desktopEditSessions.createdBy, userId),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .returning({ id: desktopEditSessions.id });

      const auditEvents: AuditEvent[] = [
        {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
          resourceId: deleted.id,
          changes: {
            deleted: {
              old: { userId, workspaceId },
              new: null,
            },
          },
          metadata: {
            closedDesktopEditSessions: closedSessions.length,
            unassignedWorkObligations: ownedWork.length,
          },
        },
      ];

      for (const work of ownedWork) {
        auditEvents.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
          resourceId: work.entityId,
          changes: {
            ownerUserId: { old: userId, new: null },
            status: {
              old: work.status,
              new: WORK_OBLIGATION_STATUS.UNASSIGNED,
            },
          },
          metadata: { cause: "owner_removed_from_workspace" },
        });
      }
      await recordAuditEvent(tx, auditEvents);

      if (leadWasCleared) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: workspaceId,
          changes: {
            leadUserId: {
              old: userId,
              new: null,
            },
          },
        });
      }

      return {
        id: deleted.id,
        closedSessionIds: closedSessions.map((session) => session.id),
      };
    }),
  );

  await dependencies.revokeWorkspaceSseAccess(workspaceId, userId);

  for (const sessionId of txResult.closedSessionIds) {
    dependencies.pushSessionEvent(sessionId, {
      type: "session-closed",
      data: { reason: "released" },
    });
    dependencies.closeSessionConnections(sessionId);
  }

  if (txResult.closedSessionIds.length > 0) {
    dependencies.broadcastWorkspaceResourceSetUpdated(
      workspaceId,
      RESOURCE_TYPE.ENTITY,
    );
  }

  return Result.ok({ id: txResult.id });
};

export const createRemoveWorkspaceMember = (
  dependencies: RemoveWorkspaceMemberDependencies = defaultRemoveWorkspaceMemberDependencies,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      workspaceId,
      params: { userId },
      user,
      recordAuditEvent,
    }) {
      return yield* removeWorkspaceMemberHandler({
        safeDb,
        workspaceId,
        userId: brandPersistedUserId(userId),
        actorUserId: user.id,
        recordAuditEvent,
        dependencies,
      });
    },
  );

const removeWorkspaceMember = createRemoveWorkspaceMember();

export default removeWorkspaceMember;
