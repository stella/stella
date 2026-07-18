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
      // The request signal can already be aborted here: the async auth
      // macro that runs before subscribe() awaits, and the client can
      // disconnect in that window. An already-aborted signal never fires
      // a fresh "abort" event, so registering the connection would leak
      // it for the process lifetime (nothing reads the orphaned stream,
      // so enqueue never throws and the self-heal delete paths never
      // run). Treat it as an immediately-closed connection: close the
      // controller and never register.
      if (signal.aborted) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        return;
      }

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
  // When this instance has no attached subscriber it never receives its
  // own published message back through the Redis loopback, so deliver
  // locally inline. This must not depend on the publisher's health: the
  // publisher is a separate lazy connection that can be healthy while the
  // subscriber never attached, in which case a successful publish would
  // otherwise reach no local client. When a subscriber IS attached, the
  // loopback (handleMessage → broadcastLocal) delivers locally, so
  // delivering inline as well would double-deliver — hence the guard on
  // the attach state evaluated here, at broadcast time.
  const deliveredLocally = !hasAttachedSubscriber();
  if (deliveredLocally) {
    broadcastLocal(workspaceId, event);
  }

  publishWorkspaceEvent(workspaceId, event).catch((error: unknown) => {
    logger.warn("sse.redis_publish_failed", {
      "error.type": errorTag(error),
    });
    // Fallback: deliver locally when Redis is unavailable so
    // single-instance deployments still get SSE invalidation. Skip it
    // when we already delivered inline above to avoid double delivery.
    if (!deliveredLocally) {
      broadcastLocal(workspaceId, event);
    }
  });
};

export const broadcastToOrganization = (
  organizationId: SafeId<"organization">,
  event: SSEEvent,
): void => {
  const deliveredLocally = !hasAttachedSubscriber();
  if (deliveredLocally) {
    broadcastLocalToOrganization(organizationId, event);
  }

  publishOrganizationEvent(organizationId, event).catch((error: unknown) => {
    logger.warn("sse.redis_publish_failed", {
      "error.type": errorTag(error),
    });
    if (!deliveredLocally) {
      broadcastLocalToOrganization(organizationId, event);
    }
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
 * Whether this instance currently has a live Redis subscriber attached. Used
 * by `broadcast`/`broadcastToOrganization` to decide whether they must
 * deliver locally inline: without a connected subscriber, a published event
 * never loops back to this instance, so local clients would be missed even
 * when the (independent) publisher connection is healthy.
 *
 * Reads the client's own live `connected` flag rather than a mirrored bit, so
 * a subscriber that Bun has auto-reconnected away from (transient drop) counts
 * as not attached for as long as it is down — during which `broadcast` falls
 * back to inline local delivery — and counts as attached again the instant its
 * connection (and Bun's re-subscribe) is restored. A stale flag could drift
 * out of step with the socket; the property cannot.
 */
const hasAttachedSubscriber = (): boolean =>
  Boolean(activeLifecycle?.subscriber?.connected);

/**
 * Bounded backoff for retrying the subscriber attach. A transient Redis
 * blip at boot must not leave this instance permanently deaf (publisher
 * healthy, subscriber never attached); retry a handful of times with a
 * short capped backoff before logging a persistent failure.
 */
const SUBSCRIBER_ATTACH_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 5000];

/**
 * Attach the cross-instance Redis subscriber for `lifecycle`, retrying with a
 * bounded backoff on failure. Written as recursion rather than a for-loop so
 * each attempt still observes success/failure sequentially without awaiting
 * inside a loop. Bails whenever `lifecycle` is no longer the active one, so a
 * stop (or stop+restart) during a connect or a backoff never attaches a stale
 * subscriber to a lifecycle that is no longer current.
 */
const attachSubscriber = async (
  lifecycle: SseLifecycle,
  attempt: number,
): Promise<void> => {
  if (activeLifecycle !== lifecycle) {
    // stopSse (and possibly a subsequent startSse) ran while we were waiting
    // between retries; abandon this attach loop.
    return;
  }

  // The client is constructed inside the try so a throwing constructor hits
  // the fail-soft catch below instead of escaping as an unhandled rejection.
  let subscriber: ReturnType<typeof createRedisClient> | undefined;
  try {
    subscriber = createRedisClient();
    await subscriber.subscribe(REDIS_CHANNEL, (message) => {
      handleMessage(message);
    });
    if (activeLifecycle !== lifecycle) {
      // stopSse (and possibly a subsequent startSse) ran while the connection
      // was still being established; do not attach a stale subscriber to a
      // lifecycle that is no longer the active one.
      subscriber.close();
      return;
    }
    lifecycle.subscriber = subscriber;
    logger.info("sse.redis_connected", { channel: REDIS_CHANNEL });
  } catch (error: unknown) {
    subscriber?.close();
    const delayMs = SUBSCRIBER_ATTACH_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || activeLifecycle !== lifecycle) {
      // Retries exhausted (or the lifecycle was torn down): surface a
      // persistent failure. Local delivery still works because
      // `broadcast`/`broadcastToOrganization` deliver inline while no
      // subscriber is attached.
      logger.error("sse.redis_connection_failed", connectionErrorFields(error));
      return;
    }
    logger.warn("sse.redis_subscribe_retry", connectionErrorFields(error));
    await Bun.sleep(delayMs);
    await attachSubscriber(lifecycle, attempt + 1);
  }
};

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

  void attachSubscriber(lifecycle, 0);

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
