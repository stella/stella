import type { SafeId } from "@/api/lib/branded-types";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createRedisClient } from "@/api/lib/redis-client";
import {
  brandPersistedDesktopEditSessionId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import {
  INSTANCE_ID,
  parseRedisPayload,
  publishOrganizationEvent,
  publishSessionEvent,
  publishWorkspaceEvent,
  REDIS_CHANNEL,
} from "@/api/lib/sse-broadcast";
import type { SSEEvent } from "@/api/lib/sse-broadcast";

/** Keep-alive interval in milliseconds (20 seconds). */
const KEEP_ALIVE_INTERVAL_MS = 20_000;

export type { SSEEvent };

type SSEConnection = {
  controller: ReadableStreamDefaultController;
  organizationId: SafeId<"organization">;
};

/** Workspace ID → connected SSE streams on THIS instance. */
const connections = new Map<SafeId<"workspace">, Set<SSEConnection>>();

const encoder = new TextEncoder();

const formatSSE = (event: SSEEvent): Uint8Array => {
  const payload = JSON.stringify({ type: event.type, data: event.data });
  return encoder.encode(`data: ${payload}\n\n`);
};

const formatKeepAlive = (): Uint8Array => encoder.encode(`:keep-alive\n\n`);

/**
 * Register a new SSE connection for a workspace.
 * Returns a ReadableStream that stays open until the client disconnects.
 */
export const subscribe = (
  workspaceId: SafeId<"workspace">,
  organizationId: SafeId<"organization">,
  signal: AbortSignal,
): ReadableStream => {
  const stream = new ReadableStream({
    start(controller) {
      const conn: SSEConnection = { controller, organizationId };

      let set = connections.get(workspaceId);
      if (!set) {
        set = new Set();
        connections.set(workspaceId, set);
      }
      set.add(conn);

      const cleanup = () => {
        set.delete(conn);
        if (set.size === 0 && connections.get(workspaceId) === set) {
          connections.delete(workspaceId);
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return stream;
};

// ── Local delivery ──────────────────────────────────────

/** Push an SSE event to local connections for a workspace. */
const broadcastLocal = (
  workspaceId: SafeId<"workspace">,
  event: SSEEvent,
): void => {
  const set = connections.get(workspaceId);
  if (!set) {
    return;
  }

  const chunk = formatSSE(event);

  for (const conn of set) {
    try {
      conn.controller.enqueue(chunk);
    } catch {
      set.delete(conn);
    }
  }

  if (set.size === 0 && connections.get(workspaceId) === set) {
    connections.delete(workspaceId);
  }
};

/** Push an SSE event to local connections for an entire organization. */
const broadcastLocalToOrganization = (
  organizationId: SafeId<"organization">,
  event: SSEEvent,
): void => {
  const chunk = formatSSE(event);

  for (const [workspaceId, set] of connections) {
    for (const conn of set) {
      if (conn.organizationId !== organizationId) {
        continue;
      }
      try {
        conn.controller.enqueue(chunk);
      } catch {
        set.delete(conn);
      }
    }
    if (set.size === 0 && connections.get(workspaceId) === set) {
      connections.delete(workspaceId);
    }
  }
};

// ── Cross-instance broadcast via Redis pub/sub ──────────
//
// The subscriber receives messages from all instances and delivers to
// local SSE connections. Publishing lives in sse-broadcast.ts so the
// scheduler can publish without importing this connection registry.

const handleMessage = (message: string) => {
  try {
    const parsed = parseRedisPayload(message);
    if (!parsed) {
      return;
    }
    if (parsed.scope === "workspace") {
      broadcastLocal(brandPersistedWorkspaceId(parsed.id), parsed.event);
    } else if (parsed.scope === "organization") {
      broadcastLocalToOrganization(
        brandPersistedOrganizationId(parsed.id),
        parsed.event,
      );
    } else if (parsed.originInstanceId !== INSTANCE_ID) {
      sessionDeliveryHandler?.(
        brandPersistedDesktopEditSessionId(parsed.id),
        parsed.event,
      );
    }
  } catch (error) {
    logger.warn("sse.invalid_redis_message", {
      "error.type": errorTag(error),
      "payload.bytes": message.length,
    });
  }
};

/**
 * Broadcast an SSE event to all API instances via Redis pub/sub.
 * Every instance (including this one) receives the message on the
 * subscriber connection and delivers to its local SSE connections.
 */
export const broadcast = (
  workspaceId: SafeId<"workspace">,
  event: SSEEvent,
): void => {
  publishWorkspaceEvent(workspaceId, event).catch((error: unknown) => {
    logger.warn("sse.redis_publish_failed", {
      "error.type": errorTag(error),
    });
    // Fallback: deliver locally when Redis is unavailable so
    // single-instance deployments still get SSE invalidation.
    broadcastLocal(workspaceId, event);
  });
};

export const broadcastToOrganization = (
  organizationId: SafeId<"organization">,
  event: SSEEvent,
): void => {
  publishOrganizationEvent(organizationId, event).catch((error: unknown) => {
    logger.warn("sse.redis_publish_failed", {
      "error.type": errorTag(error),
    });
    broadcastLocalToOrganization(organizationId, event);
  });
};

// ── Desktop-edit session events ─────────────────────────
//
// Session-scoped SSE rides the same Redis channel as workspace
// broadcasts. The desktop-edit-session-events module owns the
// per-instance connection registry; it registers a local-delivery
// handler here so cross-instance session messages reach its streams.

type SessionDeliveryHandler = (
  sessionId: SafeId<"desktopEditSession">,
  event: SSEEvent,
) => void;

let sessionDeliveryHandler: SessionDeliveryHandler | null = null;

/**
 * Register the local-delivery handler for session-scoped events.
 * Called once at startup by the desktop-edit-session-events module.
 */
export const registerSessionDelivery = (
  handler: SessionDeliveryHandler,
): void => {
  sessionDeliveryHandler = handler;
};

/**
 * Broadcast a desktop-edit session event to all API instances via
 * Redis pub/sub. Falls back to local delivery when Redis is
 * unavailable so single-instance deployments still get events.
 */
export const broadcastSessionEvent = (
  sessionId: SafeId<"desktopEditSession">,
  event: SSEEvent,
): void => {
  sessionDeliveryHandler?.(sessionId, event);

  publishSessionEvent(sessionId, event, {
    originInstanceId: INSTANCE_ID,
  }).catch((error: unknown) => {
    logger.warn("sse.redis_publish_failed", {
      "error.type": errorTag(error),
    });
  });
};

// ── Keep-alive heartbeat ────────────────────────────────

const sendKeepAlive = () => {
  const chunk = formatKeepAlive();

  for (const [workspaceId, set] of connections) {
    for (const conn of set) {
      try {
        conn.controller.enqueue(chunk);
      } catch {
        set.delete(conn);
      }
    }
    if (set.size === 0 && connections.get(workspaceId) === set) {
      connections.delete(workspaceId);
    }
  }
};

// ── Lifecycle ────────────────────────────────────────────
//
// Importing this module must have no side effects: it is pulled in
// transitively by ~24 modules (via invalidate-query-macro.ts, which most
// routes.ts files use), so an eager Redis connection or timer here would
// fire for every process that imports the route tree, including the
// exact-mirror schema guard and the test runner. `startSse`/`stopSse` make
// the keep-alive timer and the cross-instance Redis subscriber an explicit
// lifecycle that only the server's boot/shutdown path drives, mirroring the
// BullMQ `init*Worker` / `.close()` pairs in server.ts.

/**
 * One running instance of the SSE lifecycle: the keep-alive timer, plus the
 * Redis subscriber once its (async) connection attempt has attached. Object
 * identity — not a boolean flag — is what `stopSse` and the in-flight
 * connect callback use to tell "this lifecycle" apart from "whatever
 * lifecycle is active now," including a stop+restart that happens between
 * the connect's await points.
 */
type SseLifecycle = {
  keepAliveTimer: ReturnType<typeof setInterval>;
  subscriber: ReturnType<typeof createRedisClient> | null;
};

let activeLifecycle: SseLifecycle | null = null;

/**
 * Start the SSE keep-alive heartbeat and the cross-instance Redis
 * subscriber. Idempotent: a second call while already started is a no-op.
 *
 * Redis connection failure is fail-soft (logged, not thrown) so a
 * single-instance deployment without Redis still serves local SSE events
 * via `broadcastLocal`/`broadcastLocalToOrganization`.
 *
 * Ordering hazard: `broadcast`/`broadcastToOrganization`/
 * `broadcastSessionEvent` can be called before `startSse` runs (they only
 * touch the independent lazy publisher in sse-broadcast.ts and the local
 * `connections` registry, neither of which this function owns). A publish
 * that happens in that window still reaches every already-subscribed
 * instance; the only thing this instance can miss is its own event, since
 * its subscriber has not attached yet. Callers must call `startSse` before
 * accepting traffic (server.ts does so before `api.listen()`) to keep that
 * window closed in practice, matching the timing the previous
 * import-time `void initRedis()` had.
 */
export const startSse = (): void => {
  if (activeLifecycle) {
    return;
  }

  const lifecycle: SseLifecycle = {
    keepAliveTimer: setInterval(sendKeepAlive, KEEP_ALIVE_INTERVAL_MS),
    subscriber: null,
  };
  lifecycle.keepAliveTimer.unref();
  activeLifecycle = lifecycle;

  void (async () => {
    // The client is constructed inside the try so a throwing constructor
    // hits the fail-soft catch below instead of escaping this detached
    // IIFE as an unhandled rejection.
    let subscriber: ReturnType<typeof createRedisClient> | undefined;
    try {
      subscriber = createRedisClient();
      await subscriber.subscribe(REDIS_CHANNEL, (message) => {
        handleMessage(message);
      });
      if (activeLifecycle !== lifecycle) {
        // stopSse (and possibly a subsequent startSse) ran while the
        // connection was still being established; do not attach a stale
        // subscriber to a lifecycle that is no longer the active one.
        subscriber.close();
        return;
      }
      lifecycle.subscriber = subscriber;
      logger.info("sse.redis_connected", { channel: REDIS_CHANNEL });
    } catch (error: unknown) {
      logger.error("sse.redis_connection_failed", connectionErrorFields(error));
      subscriber?.close();
    }
  })();

  logger.info("sse.initialized", {
    keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
  });
};

/**
 * Stop the keep-alive heartbeat and close the Redis subscriber. Safe to
 * call when `startSse` was never called, and safe to call more than once.
 */
export const stopSse = (): void => {
  if (!activeLifecycle) {
    return;
  }
  const lifecycle = activeLifecycle;
  activeLifecycle = null;

  clearInterval(lifecycle.keepAliveTimer);

  if (lifecycle.subscriber) {
    try {
      lifecycle.subscriber.close();
    } catch (error: unknown) {
      logger.warn("sse.redis_close_failed", { "error.type": errorTag(error) });
    }
  }
};
