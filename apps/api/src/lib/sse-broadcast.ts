import { TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { createRedisClient } from "@/api/lib/redis-client";

/** Redis pub/sub channel for cross-instance SSE broadcasts. */
export const REDIS_CHANNEL = "sse:broadcast";

export const INSTANCE_ID = `api:${process.pid}:${Bun.randomUUIDv7()}`;

export type SSEEvent = {
  type: string;
  data: unknown;
};

type RedisPayload =
  | {
      scope: "organization";
      id: string;
      event: SSEEvent;
      originInstanceId?: string | undefined;
      deliveredInline?: boolean | undefined;
    }
  | {
      scope: "session";
      id: string;
      event: SSEEvent;
      originInstanceId?: string | undefined;
    }
  | {
      scope: "workspace";
      id: string;
      event: SSEEvent;
      originInstanceId?: string | undefined;
      deliveredInline?: boolean | undefined;
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
}>() {}

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
    scope !== "session"
  ) {
    return null;
  }
  if (
    !("id" in parsed) ||
    !("event" in parsed) ||
    typeof parsed.id !== "string"
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
    originInstanceId:
      "originInstanceId" in parsed &&
      typeof parsed.originInstanceId === "string"
        ? parsed.originInstanceId
        : undefined,
    deliveredInline:
      "deliveredInline" in parsed && typeof parsed.deliveredInline === "boolean"
        ? parsed.deliveredInline
        : undefined,
  };
};

let publisher: ReturnType<typeof createRedisClient> | null = null;

const getPublisher = (): ReturnType<typeof createRedisClient> => {
  publisher ??= createRedisClient();
  return publisher;
};

const publishRedisPayload = async (payload: RedisPayload): Promise<void> => {
  try {
    await getPublisher().publish(REDIS_CHANNEL, JSON.stringify(payload));
  } catch (error: unknown) {
    throw new SSEBroadcastError({
      message: "SSE broadcast publish failed.",
      cause: error,
      scope: payload.scope,
    });
  }
};

export const publishWorkspaceEvent = async (
  workspaceId: SafeId<"workspace">,
  event: SSEEvent,
  options: PublishOptions = {},
): Promise<void> => {
  await publishRedisPayload({
    scope: "workspace",
    id: workspaceId,
    event,
    originInstanceId: options.originInstanceId,
    deliveredInline: options.deliveredInline,
  });
};

export const publishOrganizationEvent = async (
  organizationId: SafeId<"organization">,
  event: SSEEvent,
  options: PublishOptions = {},
): Promise<void> => {
  await publishRedisPayload({
    scope: "organization",
    id: organizationId,
    event,
    originInstanceId: options.originInstanceId,
    deliveredInline: options.deliveredInline,
  });
};

export const publishSessionEvent = async (
  sessionId: SafeId<"desktopEditSession">,
  event: SSEEvent,
  options: { originInstanceId?: string | undefined } = {},
): Promise<void> => {
  await publishRedisPayload({
    scope: "session",
    id: sessionId,
    event,
    originInstanceId: options.originInstanceId,
  });
};
