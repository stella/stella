import { TaggedError } from "better-result";
import type { RedisOptions } from "bun";

import {
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseUserRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  type DesktopEditSessionRealtimeEvent,
  type OrganizationRealtimeEvent,
  type UserRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";

/**
 * Redis pub/sub channel for cross-instance SSE broadcasts. A channel is not a
 * key: `PUBLISH` reaches every subscriber cluster-wide regardless of slot, so
 * this name carries no hashtag. Delivery is best-effort by design; receivers
 * tolerate lost messages (`sse.ts` falls back to inline local delivery while
 * its subscriber is detached).
 */
export const REDIS_CHANNEL = "sse:broadcast";

export const INSTANCE_ID = `api:${process.pid}:${Bun.randomUUIDv7()}`;

type RedisPayload =
  | {
      scope: "organization";
      id: string;
      event: OrganizationRealtimeEvent;
      originInstanceId?: string | undefined;
      deliveredInline?: boolean | undefined;
    }
  | {
      scope: "session";
      id: string;
      event: DesktopEditSessionRealtimeEvent;
      originInstanceId?: string | undefined;
    }
  | {
      scope: "workspace";
      id: string;
      event: WorkspaceRealtimeEvent;
      originInstanceId?: string | undefined;
      deliveredInline?: boolean | undefined;
    }
  | {
      scope: "workspace-access-revoked";
      id: string;
      userId: string;
      originInstanceId?: string | undefined;
    }
  | {
      scope: "user";
      id: string;
      organizationId: string;
      event: UserRealtimeEvent;
      originInstanceId?: string | undefined;
      deliveredInline?: boolean | undefined;
    }
  | {
      scope: "user-access-revoked";
      id: string;
      organizationId: string;
      originInstanceId?: string | undefined;
    };

/**
 * Origin metadata for workspace/organization broadcasts. `originInstanceId`
 * identifies the publishing instance and `deliveredInline` records whether that
 * instance already delivered the event to its local clients inline (during a
 * subscriber attach window). A receiver drops its own looped-back copy only
 * when both hold, keeping own events exactly-once without dropping other
 * instances' events. Both are optional so a message from an
 * older-format publisher during a rolling deploy still delivers.
 */
type PublishOptions = {
  originInstanceId?: string | undefined;
  deliveredInline?: boolean | undefined;
};

export class SSEBroadcastError extends TaggedError("SSEBroadcastError")<{
  message: string;
  cause: unknown;
  scope: RedisPayload["scope"];
}> {}

export const parseRedisPayload = (raw: string): RedisPayload | null => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  if (!("scope" in parsed)) {
    return null;
  }

  const scope = parsed.scope;
  if (
    scope !== "workspace" &&
    scope !== "organization" &&
    scope !== "session" &&
    scope !== "workspace-access-revoked" &&
    scope !== "user" &&
    scope !== "user-access-revoked"
  ) {
    return null;
  }
  if (!("id" in parsed) || typeof parsed.id !== "string") {
    return null;
  }

  const originInstanceId =
    "originInstanceId" in parsed && typeof parsed.originInstanceId === "string"
      ? parsed.originInstanceId
      : undefined;

  if (scope === "user" || scope === "user-access-revoked") {
    if (
      !("organizationId" in parsed) ||
      typeof parsed.organizationId !== "string"
    ) {
      return null;
    }
    const { organizationId } = parsed;
    if (scope === "user-access-revoked") {
      return { scope, id: parsed.id, organizationId, originInstanceId };
    }
    if (!("event" in parsed)) {
      return null;
    }
    const userEvent = parseUserRealtimeEvent(parsed.event);
    return userEvent
      ? {
          scope,
          id: parsed.id,
          organizationId,
          event: userEvent,
          originInstanceId,
          deliveredInline:
            "deliveredInline" in parsed &&
            typeof parsed.deliveredInline === "boolean"
              ? parsed.deliveredInline
              : undefined,
        }
      : null;
  }

  if (scope === "workspace-access-revoked") {
    if (!("userId" in parsed) || typeof parsed.userId !== "string") {
      return null;
    }
    return {
      scope,
      id: parsed.id,
      userId: parsed.userId,
      originInstanceId,
    };
  }

  if (!("event" in parsed)) {
    return null;
  }

  if (scope === "session") {
    const event = parseDesktopEditSessionRealtimeEvent(parsed.event);
    return event ? { scope, id: parsed.id, event, originInstanceId } : null;
  }

  const deliveredInline =
    "deliveredInline" in parsed && typeof parsed.deliveredInline === "boolean"
      ? parsed.deliveredInline
      : undefined;

  if (scope === "organization") {
    const event = parseOrganizationRealtimeEvent(parsed.event);
    return event
      ? { scope, id: parsed.id, event, originInstanceId, deliveredInline }
      : null;
  }

  const event = parseWorkspaceRealtimeEvent(parsed.event);
  return event
    ? { scope, id: parsed.id, event, originInstanceId, deliveredInline }
    : null;
};

/**
 * Bound the publisher the way every other coordination facade is bounded. On
 * the client's defaults an unreachable Valkey buffers the PUBLISH in the
 * offline queue and the promise never settles, which turns a best-effort
 * broadcast into an unbounded wait: the desktop-edit-session expiry task
 * awaits its publishes, so it would hold its lease forever instead of failing
 * and rescheduling, and `sse.ts` would accumulate one pending promise per
 * event for the length of the outage.
 *
 * Refusing to buffer is the right trade here: pub/sub delivery is already
 * best-effort, and `broadcast`/`broadcastToOrganization` deliver to this
 * instance's own clients regardless of the publish outcome.
 */
const PUBLISH_CONNECT_TIMEOUT_MS = 2000;

/**
 * The connection timeout only covers reaching a peer. A peer that accepts the
 * connection and then stops replying (a partitioned node, a paused process)
 * leaves the PUBLISH itself outstanding forever, which is the same unbounded
 * wait by a different route, so the command is raced too.
 */
const PUBLISH_COMMAND_TIMEOUT_MS = 2000;

type PublisherClient = Pick<ReturnType<typeof createRedisClient>, "publish">;
type CreatePublisherClient = (options: RedisOptions) => PublisherClient;

export const createSseBroadcastPublisher = ({
  createClient = createRedisClient,
}: { createClient?: CreatePublisherClient | undefined } = {}) => {
  let publisher: PublisherClient | null = null;
  const getPublisher = (): PublisherClient => {
    publisher ??= createClient({
      connectionTimeout: PUBLISH_CONNECT_TIMEOUT_MS,
      enableOfflineQueue: false,
    });
    return publisher;
  };

  const publishRedisPayload = async (payload: RedisPayload): Promise<void> => {
    try {
      await withCommandTimeout({
        command: getPublisher().publish(REDIS_CHANNEL, JSON.stringify(payload)),
        commandTimeoutMs: PUBLISH_COMMAND_TIMEOUT_MS,
        label: "SSE broadcast publish",
      });
    } catch (error: unknown) {
      throw new SSEBroadcastError({
        message: "SSE broadcast publish failed.",
        cause: error,
        scope: payload.scope,
      });
    }
  };

  return {
    publishSessionEvent: async (
      sessionId: SafeId<"desktopEditSession">,
      event: DesktopEditSessionRealtimeEvent,
      options: { originInstanceId?: string | undefined } = {},
    ): Promise<void> => {
      await publishRedisPayload({
        scope: "session",
        id: sessionId,
        event,
        originInstanceId: options.originInstanceId,
      });
    },
    publishWorkspaceEvent: async (
      workspaceId: SafeId<"workspace">,
      event: WorkspaceRealtimeEvent,
      options: PublishOptions = {},
    ): Promise<void> => {
      await publishRedisPayload({
        scope: "workspace",
        id: workspaceId,
        event,
        originInstanceId: options.originInstanceId,
        deliveredInline: options.deliveredInline,
      });
    },
    publishWorkspaceAccessRevoked: async (
      workspaceId: SafeId<"workspace">,
      userId: SafeId<"user">,
      options: { originInstanceId?: string | undefined } = {},
    ): Promise<void> => {
      await publishRedisPayload({
        scope: "workspace-access-revoked",
        id: workspaceId,
        userId,
        originInstanceId: options.originInstanceId,
      });
    },
    publishOrganizationEvent: async (
      organizationId: SafeId<"organization">,
      event: OrganizationRealtimeEvent,
      options: PublishOptions = {},
    ): Promise<void> => {
      await publishRedisPayload({
        scope: "organization",
        id: organizationId,
        event,
        originInstanceId: options.originInstanceId,
        deliveredInline: options.deliveredInline,
      });
    },
    publishUserEvent: async (
      userId: SafeId<"user">,
      organizationId: SafeId<"organization">,
      event: UserRealtimeEvent,
      options: PublishOptions = {},
    ): Promise<void> => {
      await publishRedisPayload({
        scope: "user",
        id: userId,
        organizationId,
        event,
        originInstanceId: options.originInstanceId,
        deliveredInline: options.deliveredInline,
      });
    },
    publishUserAccessRevoked: async (
      userId: SafeId<"user">,
      organizationId: SafeId<"organization">,
      options: { originInstanceId?: string | undefined } = {},
    ): Promise<void> => {
      await publishRedisPayload({
        scope: "user-access-revoked",
        id: userId,
        organizationId,
        originInstanceId: options.originInstanceId,
      });
    },
  };
};

const defaultPublisher = createSseBroadcastPublisher();

export const {
  publishOrganizationEvent,
  publishSessionEvent,
  publishUserAccessRevoked,
  publishUserEvent,
  publishWorkspaceAccessRevoked,
  publishWorkspaceEvent,
} = defaultPublisher;
