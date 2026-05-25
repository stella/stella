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
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { entity: ["update"] },
  body: t.Object({
    entityId: tSafeId("entity"),
    propertyId: tSafeId("property"),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    // Find the session ID before closing (for SSE notification)
    const openSessions = yield* Result.await(
      safeDb(async (tx) => {
        const sessions = await tx
          .select({ id: desktopEditSessions.id })
          .from(desktopEditSessions)
          .where(
            and(
              eq(desktopEditSessions.entityId, body.entityId),
              eq(desktopEditSessions.propertyId, body.propertyId),
              eq(desktopEditSessions.workspaceId, workspaceId),
              eq(desktopEditSessions.status, "open"),
            ),
          )
          .limit(1);

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
    if (openSessions) {
      pushSessionEvent(openSessions, {
        type: "session-closed",
        data: { reason: "released" },
      });
      closeSessionConnections(openSessions);
    }

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({ released: true });
  },
);
