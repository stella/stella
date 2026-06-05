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
    }
  | {
      scope: "probe";
      originInstanceId: string;
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
  if (scope === "probe") {
    return {
      scope,
      originInstanceId:
        "originInstanceId" in parsed &&
        typeof parsed.originInstanceId === "string"
          ? parsed.originInstanceId
          : "",
    };
  }

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

export const ensureCrossInstanceBroadcastReady = async (): Promise<void> => {
  await publishRedisPayload({
    scope: "probe",
    originInstanceId: INSTANCE_ID,
  });
};

export const publishWorkspaceEvent = async (
  workspaceId: SafeId<"workspace">,
  event: SSEEvent,
): Promise<void> => {
  await publishRedisPayload({
    scope: "workspace",
    id: workspaceId,
    event,
  });
};

export const publishOrganizationEvent = async (
  organizationId: SafeId<"organization">,
  event: SSEEvent,
): Promise<void> => {
  await publishRedisPayload({
    scope: "organization",
    id: organizationId,
    event,
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
