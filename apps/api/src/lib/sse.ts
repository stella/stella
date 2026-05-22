import Redis from "ioredis";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { redisConnectionOptions } from "@/api/lib/redis-options";
import {
  brandPersistedDesktopEditSessionId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

/** Keep-alive interval in milliseconds (20 seconds). */
const KEEP_ALIVE_INTERVAL_MS = 20_000;

/** Redis pub/sub channel for cross-instance SSE broadcasts. */
const REDIS_CHANNEL = "sse:broadcast";

export type SSEEvent = {
  type: string;
  data: unknown;
};

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
// Two Redis clients: one for publishing, one for subscribing.
// The subscriber receives messages from ALL instances (including
// this one) and delivers to local SSE connections.

type RedisPayload = {
  scope: "workspace" | "organization" | "session";
  id: string;
  event: SSEEvent;
};

const parseRedisPayload = (raw: string): RedisPayload | null => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  if (
    !("scope" in parsed) ||
    !("id" in parsed) ||
    !("event" in parsed) ||
    typeof parsed.id !== "string"
  ) {
    return null;
  }
  const scope = parsed.scope;
  if (
    scope !== "workspace" &&
    scope !== "organization" &&
    scope !== "session"
  ) {
    return null;
  }
  const event = parsed.event;
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    typeof event.type !== "string"
  ) {
    return null;
  }
  return {
    scope,
    id: parsed.id,
    event: { type: event.type, data: "data" in event ? event.data : undefined },
  };
};

const publisher = new Redis(env.REDIS_URL, {
  ...redisConnectionOptions(),
  lazyConnect: true,
});
const subscriber = new Redis(env.REDIS_URL, {
  ...redisConnectionOptions(),
  lazyConnect: true,
});

const initRedis = async () => {
  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);

    await subscriber.subscribe(REDIS_CHANNEL);

    subscriber.on("message", (_channel: string, message: string) => {
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
        } else {
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
    });

    logger.info("sse.redis_connected", { channel: REDIS_CHANNEL });
  } catch (error: unknown) {
    logger.error("sse.redis_connection_failed", {
      "error.type": errorTag(error),
    });
  }
};

void initRedis();

/**
 * Broadcast an SSE event to all API instances via Redis pub/sub.
 * Every instance (including this one) receives the message on the
 * subscriber connection and delivers to its local SSE connections.
 */
export const broadcast = (
  workspaceId: SafeId<"workspace">,
  event: SSEEvent,
): void => {
  const payload: RedisPayload = {
    scope: "workspace",
    id: workspaceId,
    event,
  };
  publisher
    .publish(REDIS_CHANNEL, JSON.stringify(payload))
    .catch((error: unknown) => {
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
  const payload: RedisPayload = {
    scope: "organization",
    id: organizationId,
    event,
  };
  publisher
    .publish(REDIS_CHANNEL, JSON.stringify(payload))
    .catch((error: unknown) => {
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
  const payload: RedisPayload = { scope: "session", id: sessionId, event };
  publisher
    .publish(REDIS_CHANNEL, JSON.stringify(payload))
    .catch((error: unknown) => {
      logger.warn("sse.redis_publish_failed", {
        "error.type": errorTag(error),
      });
      sessionDeliveryHandler?.(sessionId, event);
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

const keepAliveTimer = setInterval(sendKeepAlive, KEEP_ALIVE_INTERVAL_MS);
keepAliveTimer.unref();

logger.info("sse.initialized", {
  keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
});
