import { TaggedError } from "better-result";

import {
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  type DesktopEditSessionRealtimeEvent,
  type OrganizationRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { createRedisClient } from "@/api/lib/redis-client";

/** Redis pub/sub channel for cross-instance SSE broadcasts. */
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
    scope !== "workspace-access-revoked"
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
};

export const publishWorkspaceAccessRevoked = async (
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
};

export const publishOrganizationEvent = async (
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
};

export const publishSessionEvent = async (
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
};
