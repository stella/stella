import { status, t } from "elysia";

import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  authorizeDesktopEditSession,
  DESKTOP_EDIT_SESSION_LIVENESS_REFRESH_INTERVAL_MS,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
  readDesktopEditSessionEventState,
  refreshDesktopEditSessionLiveness,
} from "@/api/lib/desktop-edit-sessions";
import { broadcastSessionEvent, registerSessionDelivery } from "@/api/lib/sse";
import type { SSEEvent } from "@/api/lib/sse";

const SESSION_TOKEN_LENGTH = 64;
const BEARER_PREFIX = "Bearer ";
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export const desktopEditSessionEventsParamsSchema = t.Object({
  sessionId: tSafeId("desktopEditSession"),
});

export const desktopEditSessionEventsHeadersSchema = t.Object({
  authorization: t.Optional(t.String()),
});

export const desktopEditSessionEventsQuerySchema = t.Object({
  sessionToken: t.Optional(t.String()),
});

type SessionEventConnection = {
  cleanup: () => void;
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
 * Internal close signal carried over the SSE channel. Never enqueued
 * to clients — it tears down the streams instead.
 */
const SESSION_CLOSE_SIGNAL = "__desktop_edit_session_closed__";

/**
 * Deliver a session event to SSE connections held by THIS instance.
 * Invoked by the Redis pub/sub fan-out (and by the local fallback when
 * Redis is unavailable). The close signal tears the streams down
 * rather than enqueueing a chunk.
 */
const deliverSessionEventLocal = (
  sessionId: SafeId<"desktopEditSession">,
  event: SSEEvent,
): void => {
  const conns = connections.get(sessionId);
  if (!conns) {
    return;
  }

  if (event.type === SESSION_CLOSE_SIGNAL) {
    for (const conn of conns) {
      conn.cleanup();
      try {
        conn.controller.close();
      } catch {
        // Already closed.
      }
    }
    connections.delete(sessionId);
    return;
  }

  const encoded = formatSSE(event);
  for (const conn of conns) {
    try {
      conn.controller.enqueue(encoded);
    } catch {
      conn.cleanup();
      conns.delete(conn);
    }
  }

  if (conns.size === 0 && connections.get(sessionId) === conns) {
    connections.delete(sessionId);
  }
};

// Cross-instance fan-out: every API instance receives session messages
// on the shared Redis channel and delivers to its local streams.
registerSessionDelivery(deliverSessionEventLocal);

/**
 * Push an event to all SSE connections for a session, across every API
 * instance. Called from takeover request, release, and expiry handlers.
 */
export const pushSessionEvent = (
  sessionId: SafeId<"desktopEditSession">,
  event: SSEEvent,
): void => {
  broadcastSessionEvent(sessionId, event);
};

/**
 * Close all SSE connections for a session, across every API instance
 * (e.g., on session finalize or close).
 */
export const closeSessionConnections = (
  sessionId: SafeId<"desktopEditSession">,
): void => {
  broadcastSessionEvent(sessionId, { type: SESSION_CLOSE_SIGNAL, data: null });
};

type DesktopEditSessionEventsHandlerProps = {
  headers: { authorization?: string };
  query: { sessionToken?: string };
  sessionId: SafeId<"desktopEditSession">;
};

export const desktopEditSessionEventsHandler = async ({
  headers: { authorization },
  query: { sessionToken: legacySessionToken },
  sessionId,
}: DesktopEditSessionEventsHandlerProps) => {
  const sessionToken = getSessionToken({ authorization, legacySessionToken });

  if (!sessionToken) {
    return status(401, {
      code: "desktop_edit_session_token_missing",
      message: "Desktop edit session token missing or malformed.",
    });
  }

  const authorized = await authorizeDesktopEditSession({
    sessionId,
    sessionToken,
  });

  if (authorized.status === "missing") {
    return status(404, {
      message: "Desktop edit session not found.",
    });
  }
  if (authorized.status === "token-mismatch") {
    return status(409, {
      code: DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
      message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
    });
  }
  if (authorized.status === "token-expired") {
    return status(401, {
      code: "desktop_edit_session_token_expired",
      message:
        "Desktop edit session token has expired. Reopen the document from stella.",
    });
  }
  if (authorized.status === "permission-revoked") {
    return status(403, {
      code: "desktop_edit_session_permission_revoked",
      message:
        "Desktop edit permission was revoked. Reopen the document from stella.",
    });
  }

  const eventState = await readDesktopEditSessionEventState(sessionId);

  if (!eventState) {
    return status(404, {
      message: "Desktop edit session not found or closed.",
    });
  }

  const userId = authorized.value.userId;

  // Declare conn in outer scope so cancel() can reference the exact instance.
  let conn: SessionEventConnection;
  let livenessRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const cleanupLivenessRefresh = () => {
    if (livenessRefreshTimer === null) {
      return;
    }
    clearInterval(livenessRefreshTimer);
    livenessRefreshTimer = null;
  };

  const refreshLiveness = () => {
    void refreshDesktopEditSessionLiveness({ sessionId, userId }).catch(
      (error: unknown) => {
        captureError(error, { sessionId });
      },
    );
  };

  const stream = new ReadableStream({
    start(controller) {
      refreshLiveness();
      livenessRefreshTimer = setInterval(
        refreshLiveness,
        DESKTOP_EDIT_SESSION_LIVENESS_REFRESH_INTERVAL_MS,
      );

      conn = { cleanup: cleanupLivenessRefresh, controller, sessionId };

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
      const pending = eventState.pendingRequest;
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
      cleanupLivenessRefresh();
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

type GetSessionTokenOptions = {
  authorization: string | undefined;
  legacySessionToken: string | undefined;
};

const getSessionToken = ({
  authorization,
  legacySessionToken,
}: GetSessionTokenOptions): string | null => {
  if (authorization) {
    if (
      !authorization.startsWith(BEARER_PREFIX) ||
      authorization.length !== BEARER_PREFIX.length + SESSION_TOKEN_LENGTH
    ) {
      return null;
    }
    const bearerToken = authorization.slice(BEARER_PREFIX.length);
    return SESSION_TOKEN_PATTERN.test(bearerToken) ? bearerToken : null;
  }

  if (legacySessionToken && SESSION_TOKEN_PATTERN.test(legacySessionToken)) {
    return legacySessionToken;
  }

  return null;
};
