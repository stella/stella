import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  desktopEditSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  closeSessionConnections,
  pushSessionEvent,
} from "@/api/handlers/entities/desktop-edit-session-events";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tUserId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { workspace: ["update"] },
  params: workspaceParams({ userId: tUserId }),
} satisfies HandlerConfig;

const removeWorkspaceMember = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params: { userId },
    recordAuditEvent,
  }) {
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

        await recordAuditEvent(tx, {
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
          },
        });

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

    for (const sessionId of txResult.closedSessionIds) {
      pushSessionEvent(sessionId, {
        type: "session-closed",
        data: { reason: "released" },
      });
      closeSessionConnections(sessionId);
    }

    if (txResult.closedSessionIds.length > 0) {
      broadcast(workspaceId, {
        type: "invalidate-query",
        data: ["entities", workspaceId],
      });
    }

    return Result.ok({ id: txResult.id });
  },
);

export default removeWorkspaceMember;
