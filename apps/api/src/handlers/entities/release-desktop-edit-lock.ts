import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { desktopEditSessions } from "@/api/db/schema";
import {
  closeSessionConnections,
  pushSessionEvent,
} from "@/api/handlers/entities/desktop-edit-session-events";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { liveOwnDesktopEditSessionTargetPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: t.Object({
    entityId: tSafeId("entity"),
    propertyId: tSafeId("property"),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    // Find the session ID before closing (for SSE notification)
    const releasedSessionId = yield* Result.await(
      safeDb(async (tx) => {
        const sessions = await tx
          .select({ id: desktopEditSessions.id })
          .from(desktopEditSessions)
          .where(
            and(
              ...liveOwnDesktopEditSessionTargetPredicates({
                entityId: body.entityId,
                now: new Date(),
                propertyId: body.propertyId,
                userId: user.id,
                workspaceId,
              }),
            ),
          )
          .orderBy(desktopEditSessions.createdAt)
          .limit(1)
          .for("update");

        const session = sessions.at(0);
        if (session) {
          await tx
            .update(desktopEditSessions)
            .set({ status: "cancelled", closedAt: new Date() })
            .where(eq(desktopEditSessions.id, session.id));

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
            resourceId: session.id,
            changes: {
              status: { old: "open", new: "cancelled" },
            },
            metadata: { reason: "released_by_user" },
          });
        }

        return session?.id ?? null;
      }),
    );

    // Notify the desktop app via SSE before closing the connection
    if (releasedSessionId) {
      pushSessionEvent(releasedSessionId, {
        type: "session-closed",
        data: { reason: "released" },
      });
      closeSessionConnections(releasedSessionId);
      broadcast(workspaceId, {
        type: "invalidate-query",
        data: ["entities", workspaceId],
      });
    }

    return Result.ok({ released: releasedSessionId !== null });
  },
);
