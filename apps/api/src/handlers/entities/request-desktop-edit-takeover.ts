import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { desktopEditSessions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { pushSessionEvent } from "./desktop-edit-session-events";

const config = {
  permissions: { entity: ["update"] },
  body: t.Object({
    entityId: tSafeId("entity"),
    propertyId: tSafeId("property"),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    body,
    safeDb,
    session: authSession,
    user: currentUser,
    workspaceId,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const sessions = await tx
          .select({
            id: desktopEditSessions.id,
            createdBy: desktopEditSessions.createdBy,
          })
          .from(desktopEditSessions)
          .where(
            and(
              eq(desktopEditSessions.entityId, body.entityId),
              eq(desktopEditSessions.propertyId, body.propertyId),
              eq(desktopEditSessions.workspaceId, workspaceId),
              ...liveDesktopEditSessionPredicates(new Date()),
            ),
          )
          .orderBy(desktopEditSessions.createdAt)
          .limit(1)
          .for("update");

        const editSession = sessions.at(0);
        if (!editSession) {
          return { status: "no_session" as const };
        }

        if (editSession.createdBy === currentUser.id) {
          return { status: "own_session" as const };
        }

        const now = new Date();
        await tx
          .update(desktopEditSessions)
          .set({
            takeoverRequestedBy: currentUser.id,
            takeoverRequestedAt: now,
          })
          .where(eq(desktopEditSessions.id, editSession.id));

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
          resourceId: editSession.id,
          changes: {
            takeoverRequestedBy: {
              old: null,
              new: currentUser.id,
            },
          },
          metadata: { reason: "takeover_requested" },
        });

        // Get the requesting user's name for the notification
        const requestingUser = await tx
          .select({ name: user.name })
          .from(member)
          .innerJoin(user, eq(member.userId, user.id))
          .where(
            and(
              eq(member.userId, currentUser.id),
              eq(member.organizationId, authSession.activeOrganizationId),
            ),
          )
          .limit(1);

        const requestedByName = requestingUser.at(0)?.name ?? currentUser.id;

        return {
          status: "requested" as const,
          sessionId: editSession.id,
          requestedByName,
          requestedAt: now.toISOString(),
        };
      }),
    );

    if (result.status === "no_session") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "No active desktop edit session found.",
        }),
      );
    }

    if (result.status === "own_session") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot request takeover of your own session.",
        }),
      );
    }

    // Push SSE event after transaction commits to avoid notifying
    // before the DB state is visible.
    pushSessionEvent(result.sessionId, {
      type: "takeover-requested",
      data: {
        requestedBy: result.requestedByName,
        requestedAt: result.requestedAt,
      },
    });

    return Result.ok({ status: "requested" });
  },
);
