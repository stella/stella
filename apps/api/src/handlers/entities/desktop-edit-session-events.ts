import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { db } from "@/api/db/root";
import { desktopEditSessions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

export const desktopEditSessionEventsParamsSchema = t.Object({
  sessionId: tSafeId("desktopEditSession"),
});

export const desktopEditSessionEventsQuerySchema = t.Object({});

type SessionEventConnection = {
  controller: ReadableStreamDefaultController;
  sessionId: SafeId<"desktopEditSession">;
};

/** Session ID → connected SSE streams. */
const connections = new Map<
  SafeId<"desktopEditSession">,
  Set<SessionEventConnection>
>();

const encoder = new TextEncoder();

const formatSSE = (event: { type: string; data: unknown }): Uint8Array => {
  const payload = JSON.stringify(event);
  return encoder.encode(`data: ${payload}\n\n`);
};

/**
 * Push an event to all SSE connections for a given session.
 * Called from takeover request, release, and expiry handlers.
 */
export const pushSessionEvent = (
  sessionId: SafeId<"desktopEditSession">,
  event: { type: string; data: unknown },
): void => {
  const conns = connections.get(sessionId);
  if (!conns) {
    return;
  }

  const encoded = formatSSE(event);
  for (const conn of conns) {
    try {
      conn.controller.enqueue(encoded);
    } catch {
      // Connection closed; will be cleaned up on cancel
    }
  }
};

/**
 * Close all SSE connections for a session (e.g., on session close).
 */
export const closeSessionConnections = (
  sessionId: SafeId<"desktopEditSession">,
): void => {
  const conns = connections.get(sessionId);
  if (!conns) {
    return;
  }

  for (const conn of conns) {
    try {
      conn.controller.close();
    } catch {
      // Already closed
    }
  }
  connections.delete(sessionId);
};

type DesktopEditSessionEventsHandlerProps = {
  sessionId: SafeId<"desktopEditSession">;
};

export const desktopEditSessionEventsHandler = async ({
  sessionId,
}: DesktopEditSessionEventsHandlerProps) => {
  // SSE connections are authenticated by session ID + open status only.
  // The token was validated on the initial open_docx call; we don't
  // re-validate here because token rotation would break reconnects.
  const sessions = await db
    .select({ id: desktopEditSessions.id })
    .from(desktopEditSessions)
    .where(
      and(
        eq(desktopEditSessions.id, sessionId),
        eq(desktopEditSessions.status, "open"),
      ),
    )
    .limit(1);

  if (!sessions.at(0)) {
    return status(404, {
      message: "Desktop edit session not found or closed.",
    });
  }

  // Check for pending takeover request to send immediately on connect
  const pendingRequest = await db
    .select({
      requestedByName: user.name,
      requestedAt: desktopEditSessions.takeoverRequestedAt,
    })
    .from(desktopEditSessions)
    .innerJoin(workspaces, eq(desktopEditSessions.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(desktopEditSessions.takeoverRequestedBy, member.userId),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(user, eq(member.userId, user.id))
    .where(eq(desktopEditSessions.id, sessionId))
    .limit(1);

  // Declare conn in outer scope so cancel() can reference the exact instance.
  let conn: SessionEventConnection;

  const stream = new ReadableStream({
    start(controller) {
      conn = { controller, sessionId };

      let sessionConns = connections.get(sessionId);
      if (!sessionConns) {
        sessionConns = new Set();
        connections.set(sessionId, sessionConns);
      }
      sessionConns.add(conn);

      // Send an SSE comment to flush response headers immediately.
      // Without this, Bun may buffer the response until the first
      // real data chunk, causing clients to hang on connect.
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Send any pending takeover request immediately
      const pending = pendingRequest.at(0);
      if (pending?.requestedAt) {
        controller.enqueue(
          formatSSE({
            type: "takeover-requested",
            data: {
              requestedBy: pending.requestedByName ?? "Another user",
              requestedAt: pending.requestedAt.toISOString(),
            },
          }),
        );
      }
    },
    cancel() {
      const sessionConns = connections.get(sessionId);
      if (sessionConns) {
        sessionConns.delete(conn);
        if (sessionConns.size === 0) {
          connections.delete(sessionId);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};
