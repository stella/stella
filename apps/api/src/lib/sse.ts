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

/**
 * Whether a looped-back workspace/organization payload is one THIS instance
 * already delivered inline during a subscriber attach/reattach window (when
 * `subscriptionLive` was false at broadcast time but Redis had already accepted
 * our SUBSCRIBE, so the event both delivered inline and comes back on the
 * loopback). Dropping only that duplicate copy keeps own events exactly-once
 * without affecting other instances' events, which never carry our origin id
 * and must still deliver via loopback. Absent fields (older-format publisher on
 * a rolling deploy) never match, so such messages always deliver.
 */
const isOwnInlineDelivery = (payload: {
  originInstanceId?: string | undefined;
  deliveredInline?: boolean | undefined;
}): boolean =>
  payload.deliveredInline === true && payload.originInstanceId === INSTANCE_ID;

const handleMessage = (message: string) => {
  try {
    const parsed = parseRedisPayload(message);
    if (!parsed) {
      return;
    }
    if (parsed.scope === "workspace") {
      if (isOwnInlineDelivery(parsed)) {
        return;
      }
      broadcastLocal(brandPersistedWorkspaceId(parsed.id), parsed.event);
    } else if (parsed.scope === "organization") {
      if (isOwnInlineDelivery(parsed)) {
        return;
      }
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
  // the attach state evaluated here, at broadcast time. During an attach
  // window the guard can read "not attached" while Redis has already accepted
  // our SUBSCRIBE, so the event both delivers inline AND loops back; the
  // origin metadata below lets handleMessage drop that duplicate loopback copy.
  const deliveredLocally = !hasAttachedSubscriber();
  if (deliveredLocally) {
    broadcastLocal(workspaceId, event);
  }

  publishWorkspaceEvent(workspaceId, event, {
    originInstanceId: INSTANCE_ID,
    deliveredInline: deliveredLocally,
  }).catch((error: unknown) => {
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

  publishOrganizationEvent(organizationId, event, {
    originInstanceId: INSTANCE_ID,
    deliveredInline: deliveredLocally,
  }).catch((error: unknown) => {
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
  /**
   * Whether `subscriber` currently holds a live SUBSCRIBE on its present
   * connection. Set true only after a confirmed subscribe on the active
   * client; set false the moment a reconnect is observed (the old connection's
   * subscription is gone) and while a replacement client is attaching. Distinct
   * from the socket's `connected` flag because Bun reconnects the socket
   * WITHOUT re-issuing SUBSCRIBE — so a `connected` client can be silently deaf.
   */
  subscriptionLive: boolean;
  /**
   * Pending retry timer for the next attach attempt, or null when an attempt is
   * running or a subscriber is attached. Each failed attempt schedules the next
   * via `setTimeout` and returns, so attempts never await one another (no
   * unbounded promise/stack chain over a long outage). `stopSse` clears it.
   */
  attachTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Monotonic delivery generation. Each attach captures the current value in
   * its subscribe callback; every invalidation (a candidate that failed, the
   * deaf client on reconnect, the active subscriber at shutdown) bumps it. The
   * callback delivers only while its captured generation still equals this, so
   * a stale client whose `close()` threw — leaving its pub/sub callback live —
   * can never deliver alongside its replacement, regardless of `close()`
   * behaviour. This is structural: it does not depend on cleanup succeeding.
   */
  generation: number;
};

let activeLifecycle: SseLifecycle | null = null;

/**
 * Whether this instance currently has a live, subscribed Redis subscriber. Used
 * by `broadcast`/`broadcastToOrganization` to decide whether they must deliver
 * locally inline: without a subscribed subscriber a published event never loops
 * back to this instance, so local clients would be missed even when the
 * (independent) publisher connection is healthy.
 *
 * Requires BOTH the socket to be `connected` AND `subscriptionLive`. Bun's
 * RedisClient auto-reconnects a dropped subscriber but does NOT re-issue
 * SUBSCRIBE, so `connected` alone would report a reconnected-but-deaf client as
 * attached and silently drop this instance's events. During the disconnected
 * window (`connected` false) and the reconnect/reattach window
 * (`subscriptionLive` false) this returns false, routing broadcasts to inline
 * local delivery so nothing is missed.
 */
const hasAttachedSubscriber = (): boolean =>
  Boolean(
    activeLifecycle?.subscriber?.connected && activeLifecycle.subscriptionLive,
  );

/**
 * Backoff ramp for retrying the subscriber attach. A transient Redis blip at
 * boot must not leave this instance permanently deaf (publisher healthy,
 * subscriber never attached), and — since inline local delivery only covers
 * this instance's own events — a longer outage must self-heal on recovery
 * rather than miss every other replica's events until the process restarts.
 * So after this ramp, retries continue forever at the steady capped interval.
 */
const SUBSCRIBER_ATTACH_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 5000];

/** Capped interval every retry uses once the ramp above is exhausted. */
const SUBSCRIBER_ATTACH_STEADY_DELAY_MS = 5000;

/**
 * When retrying at the steady interval, escalate to a single error log the
 * moment the ramp is exhausted, then warn only every Nth steady attempt so a
 * prolonged outage does not spam the logs (≈ once per minute at 5s).
 */
const SUBSCRIBER_ATTACH_STEADY_LOG_EVERY = 12;

/**
 * Close a subscriber client best-effort: a throwing `close()` (mirroring how
 * `stopSse` already treats it) must never abort the caller. This matters most
 * on the attach-failure and reconnect-teardown paths, where an exception here
 * would skip the retry scheduling and leave the instance permanently deaf.
 */
const closeSubscriberQuietly = (
  client: ReturnType<typeof createRedisClient>,
): void => {
  try {
    client.close();
  } catch (error: unknown) {
    logger.warn("sse.redis_close_failed", { "error.type": errorTag(error) });
  }
};

/**
 * Run one attach attempt for `lifecycle`. On success it attaches the subscriber
 * and wires reconnect handling; on failure it logs and schedules the NEXT
 * attempt via a timer, then returns. Attempts therefore never await one another
 * — no unbounded promise/stack chain builds up over a long outage. Bails
 * whenever `lifecycle` is no longer the active one, so a stop (or stop+restart)
 * during a connect or a backoff never attaches a stale subscriber.
 */
const runAttachAttempt = async (
  lifecycle: SseLifecycle,
  attempt: number,
): Promise<void> => {
  if (activeLifecycle !== lifecycle) {
    return;
  }

  // The client is constructed inside the try so a throwing constructor hits
  // the fail-soft catch below instead of escaping as an unhandled rejection.
  let subscriber: ReturnType<typeof createRedisClient> | undefined;
  try {
    subscriber = createRedisClient();
    const attached = subscriber;
    // Capture the generation this client is attaching under. The callback stays
    // authorized to deliver only while the lifecycle's generation still matches;
    // any later invalidation bumps it, structurally silencing a stale client
    // even if its close() threw and left this callback live.
    const attachGeneration = lifecycle.generation;
    await attached.subscribe(REDIS_CHANNEL, (message) => {
      if (
        activeLifecycle === lifecycle &&
        lifecycle.generation === attachGeneration
      ) {
        handleMessage(message);
      }
    });
    if (activeLifecycle !== lifecycle) {
      // stopSse (and possibly a subsequent startSse) ran while the connection
      // was still being established; do not attach a stale subscriber to a
      // lifecycle that is no longer the active one.
      closeSubscriberQuietly(attached);
      return;
    }
    lifecycle.subscriber = attached;
    lifecycle.subscriptionLive = true;
    // Bun auto-reconnects a dropped subscriber but does NOT re-issue SUBSCRIBE,
    // and re-subscribing on the SAME client double-registers the callback (both
    // verified against a mock RESP3 server), which would double-deliver every
    // event locally. So on any reconnect, drop this now-deaf client and attach
    // a fresh one, which subscribes exactly once on the new connection. Exactly-
    // once local delivery holds because `subscriptionLive` is false for the
    // whole deaf/reattach window, routing broadcasts to inline delivery until
    // the replacement is subscribed. The initial connect fired before this
    // handler was registered, so it runs only for genuine reconnects.
    attached.onReconnect(() => {
      if (activeLifecycle !== lifecycle || lifecycle.subscriber !== attached) {
        return;
      }
      lifecycle.subscriptionLive = false;
      lifecycle.subscriber = null;
      // Invalidate the deaf client's generation BEFORE closing it, so it stops
      // delivering even if close() throws and leaves its callback live. The
      // close itself is then only best-effort resource cleanup.
      lifecycle.generation += 1;
      closeSubscriberQuietly(attached);
      logger.warn("sse.redis_subscriber_reconnected", {
        channel: REDIS_CHANNEL,
      });
      launchAttachAttempt(lifecycle, 0);
    });
    logger.info("sse.redis_connected", { channel: REDIS_CHANNEL });
  } catch (error: unknown) {
    // Invalidate the failed candidate's generation BEFORE closing it, then
    // close best-effort: a throwing close() must neither leave the candidate's
    // callback able to deliver nor skip the retry scheduling below (which would
    // stop the instance retrying and leave it deaf until restart).
    if (subscriber) {
      lifecycle.generation += 1;
      closeSubscriberQuietly(subscriber);
    }
    if (activeLifecycle !== lifecycle) {
      // The lifecycle was torn down (stop, or stop+restart) during the
      // attempt; abandon the retry chain quietly.
      return;
    }
    const rampDelay = SUBSCRIBER_ATTACH_RETRY_DELAYS_MS[attempt];
    const delayMs = rampDelay ?? SUBSCRIBER_ATTACH_STEADY_DELAY_MS;
    if (rampDelay !== undefined) {
      // Still ramping up after a transient blip.
      logger.warn("sse.redis_subscribe_retry", connectionErrorFields(error));
    } else {
      const steadyAttempt = attempt - SUBSCRIBER_ATTACH_RETRY_DELAYS_MS.length;
      if (steadyAttempt === 0) {
        // Ramp exhausted: escalate once to surface a persistent outage. Retries
        // continue at the steady interval so the instance self-heals whenever
        // Redis recovers; inline local delivery covers this instance's own
        // events meanwhile, but other replicas' events need the subscriber.
        logger.error(
          "sse.redis_connection_failed",
          connectionErrorFields(error),
        );
      } else if (steadyAttempt % SUBSCRIBER_ATTACH_STEADY_LOG_EVERY === 0) {
        logger.warn("sse.redis_subscribe_retry", connectionErrorFields(error));
      }
    }
    scheduleAttachAttempt(lifecycle, attempt + 1, delayMs);
  }
};

/**
 * Kick off an attach attempt as detached work, capturing any unexpected
 * rejection (`runAttachAttempt` handles expected connection failures itself, so
 * this guards only against a throw the attempt did not model, keeping it from
 * becoming an unhandled rejection). Handling the promise with `.catch` here is
 * why no caller needs a bare `void` on the attempt.
 */
const launchAttachAttempt = (
  lifecycle: SseLifecycle,
  attempt: number,
): void => {
  runAttachAttempt(lifecycle, attempt).catch((error: unknown) => {
    logger.error("sse.redis_connection_failed", connectionErrorFields(error));
  });
};

/**
 * Schedule the next attach attempt after `delayMs`. The timer is unref'd (like
 * the keep-alive timer) so a pending retry never keeps the process alive on its
 * own, and tracked on the lifecycle so `stopSse` can clear it.
 */
const scheduleAttachAttempt = (
  lifecycle: SseLifecycle,
  attempt: number,
  delayMs: number,
): void => {
  const timer = setTimeout(() => {
    launchAttachAttempt(lifecycle, attempt);
  }, delayMs);
  timer.unref();
  lifecycle.attachTimer = timer;
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
    subscriptionLive: false,
    attachTimer: null,
    generation: 0,
  };
  lifecycle.keepAliveTimer.unref();
  activeLifecycle = lifecycle;

  // First attempt runs immediately; only retries are timer-scheduled.
  launchAttachAttempt(lifecycle, 0);

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

  if (lifecycle.attachTimer) {
    clearTimeout(lifecycle.attachTimer);
    lifecycle.attachTimer = null;
  }

  if (lifecycle.subscriber) {
    // Invalidate the active subscriber's generation before shutdown cleanup so
    // it cannot deliver even if close() throws.
    lifecycle.generation += 1;
    closeSubscriberQuietly(lifecycle.subscriber);
  }
};
