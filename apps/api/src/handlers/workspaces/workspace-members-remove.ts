import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { RESOURCE_TYPE } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
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
};

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
}: RemoveWorkspaceMemberProps) {
  // Lock + delete in one transaction to prevent TOCTOU.
  // FOR UPDATE on the row select (not aggregate) locks
  // member rows so concurrent removals serialize.
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      const workspaceRows = await tx
        .select({ leadUserId: workspaces.leadUserId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");
      const workspace = workspaceRows.at(0);

      if (!workspace) {
        return { ok: false as const, reason: "not-found" as const };
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
        return { ok: false as const, reason: "not-found" as const };
      }

      if (lockedRows.length <= 1) {
        return { ok: false as const, reason: "last-member" as const };
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
        return { ok: false as const, reason: "owned-work-limit" as const };
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
        return { ok: false as const, reason: "not-found" as const };
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
        ok: true as const,
        id: deleted.id,
        closedSessionIds: closedSessions.map((session) => session.id),
      };
    }),
  );

  if (!txResult.ok) {
    if (txResult.reason === "owned-work-limit") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `Cannot remove a member with more than ${LIMITS.workspaceMemberRemovalWorkObligationsMax} owned work obligations. Reassign their work first.`,
        }),
      );
    }
    if (txResult.reason === "last-member") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot remove the last workspace member",
        }),
      );
    }
    return Result.err(
      new HandlerError({ status: 404, message: "Member not found" }),
    );
  }

  await revokeWorkspaceSseAccess(workspaceId, userId);

  for (const sessionId of txResult.closedSessionIds) {
    pushSessionEvent(sessionId, {
      type: "session-closed",
      data: { reason: "released" },
    });
    closeSessionConnections(sessionId);
  }

  if (txResult.closedSessionIds.length > 0) {
    broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.ENTITY);
  }

  return Result.ok({ id: txResult.id });
};

const removeWorkspaceMember = createSafeHandler(
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
    });
  },
);

export default removeWorkspaceMember;
