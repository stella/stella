import { describe, expect, test } from "bun:test";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";
import { deferred } from "@stll/test-kit";

import { toSafeId } from "@/api/lib/branded-types";
import {
  createSseBroadcastPublisher,
  parseRedisPayload,
} from "@/api/lib/sse-broadcast";

const redisPayload = (
  scope: "organization" | "session" | "workspace",
  event: unknown,
) =>
  JSON.stringify({ scope, id: "00000000-0000-4000-8000-000000000001", event });

describe("SSE Redis payload parsing", () => {
  test("accepts a valid event for each scope", () => {
    expect(
      parseRedisPayload(
        redisPayload("workspace", {
          type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
          data: {
            runId: "00000000-0000-4000-8000-000000000002",
            status: "running",
            currentStepIndex: 0,
            steps: [],
          },
        }),
      )?.scope,
    ).toBe("workspace");
    expect(
      parseRedisPayload(
        redisPayload("organization", {
          type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
          resourceType: RESOURCE_TYPE.ORGANIZATION,
        }),
      )?.scope,
    ).toBe("organization");
    expect(
      parseRedisPayload(
        redisPayload("workspace", {
          type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
          resource: {
            type: RESOURCE_TYPE.ENTITY,
            id: "00000000-0000-4000-8000-000000000002",
          },
        }),
      )?.scope,
    ).toBe("workspace");
    expect(
      parseRedisPayload(
        redisPayload("session", {
          type: REALTIME_EVENT_TYPE.SESSION_CLOSED,
          data: { reason: "expired" },
        }),
      )?.scope,
    ).toBe("session");
    expect(
      parseRedisPayload(
        JSON.stringify({
          scope: "workspace-access-revoked",
          id: "00000000-0000-4000-8000-000000000001",
          userId: "00000000-0000-4000-8000-000000000005",
        }),
      )?.scope,
    ).toBe("workspace-access-revoked");
  });

  test("rejects events that are malformed or invalid for their scope", () => {
    expect(
      parseRedisPayload(
        redisPayload("workspace", {
          type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
          resourceType: "unknown",
        }),
      ),
    ).toBeNull();
    expect(
      parseRedisPayload(
        redisPayload("organization", {
          type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
          data: {
            entityId: "00000000-0000-4000-8000-000000000002",
            entityVersionId: "00000000-0000-4000-8000-000000000003",
            propertyId: "00000000-0000-4000-8000-000000000004",
            answer: "Draft answer",
            status: "streaming",
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseRedisPayload(
        redisPayload("organization", {
          type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
          resource: {
            type: RESOURCE_TYPE.ENTITY,
            id: "00000000-0000-4000-8000-000000000002",
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseRedisPayload(
        redisPayload("workspace", {
          type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
          resource: { type: RESOURCE_TYPE.ENTITY, id: "" },
        }),
      ),
    ).toBeNull();
    expect(
      parseRedisPayload(
        redisPayload("session", {
          type: REALTIME_EVENT_TYPE.SESSION_TAKEN_OVER,
          data: {},
        }),
      ),
    ).toBeNull();
    expect(
      parseRedisPayload(
        JSON.stringify({
          scope: "workspace-access-revoked",
          id: "00000000-0000-4000-8000-000000000001",
        }),
      ),
    ).toBeNull();
  });
});

test("the publisher constructs a cache client with bounded connection options", async () => {
  const constructed: unknown[] = [];
  const published: unknown[] = [];
  const publisher = createSseBroadcastPublisher({
    createClient: (options) => {
      constructed.push(options);
      return {
        connect: async () => undefined,
        close: () => undefined,
        onClose: () => () => undefined,
        publish: async (...args) => {
          published.push(args);
          return 0;
        },
      };
    },
  });
  const sessionId = toSafeId<"desktopEditSession">(
    "00000000-0000-4000-8000-000000000001",
  );
  const event = {
    type: REALTIME_EVENT_TYPE.SESSION_CLOSED,
    data: { reason: "expired" },
  } as const;
  await publisher.publishSessionEvent(sessionId, event);
  await publisher.publishSessionEvent(sessionId, event);
  expect(constructed).toEqual([
    {
      storeClass: "cache",
      overrides: { connectionTimeout: 2000, enableOfflineQueue: false },
    },
  ]);
  expect(published).toHaveLength(2);
});

test("concurrent first events wait for one connection before publishing", async () => {
  const connected = deferred();
  const started = deferred();
  let connections = 0;
  let ready = false;
  const messages: string[] = [];
  const publisher = createSseBroadcastPublisher({
    createClient: () => ({
      connect: async () => {
        connections += 1;
        started.resolve();
        await connected.promise;
        ready = true;
      },
      close: () => undefined,
      onClose: () => () => undefined,
      publish: async (_channel, message) => {
        expect(ready).toBe(true);
        messages.push(message);
        return 0;
      },
    }),
  });
  const session = publisher.publishSessionEvent(
    toSafeId<"desktopEditSession">("00000000-0000-4000-8000-000000000001"),
    { type: REALTIME_EVENT_TYPE.SESSION_CLOSED, data: { reason: "expired" } },
  );
  const workspace = publisher.publishWorkspaceEvent(
    toSafeId<"workspace">("00000000-0000-4000-8000-000000000002"),
    {
      type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
      resourceType: RESOURCE_TYPE.ENTITY,
    },
  );
  const completed = Promise.all([session, workspace]).then(
    () => ({ type: "published" as const }),
    (error: unknown) => ({ type: "failure" as const, error }),
  );
  try {
    expect(
      await Promise.race([
        started.promise.then(() => "started"),
        completed.then(() => "completed"),
      ]),
    ).toBe("started");
    expect(connections).toBe(1);
    expect(messages).toEqual([]);
  } finally {
    connected.resolve();
  }
  expect(await completed).toEqual({ type: "published" });
  expect(messages.map((message) => parseRedisPayload(message)?.scope)).toEqual([
    "session",
    "workspace",
  ]);
});

test("an MCP tool projection change round-trips for an organisation or one member", async () => {
  const published: string[] = [];
  const publisher = createSseBroadcastPublisher({
    createClient: () => ({
      connect: async () => undefined,
      close: () => undefined,
      onClose: () => () => undefined,
      publish: async (_channel, message) => {
        published.push(message);
        return 0;
      },
    }),
  });
  await publisher.publishMcpToolProjectionChange(
    {
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
    },
    { originInstanceId: "api:origin" },
  );
  await publisher.publishMcpToolProjectionChange({
    organizationId: toSafeId<"organization">("org_1"),
  });
  expect(published.map((message) => parseRedisPayload(message))).toEqual([
    {
      scope: "mcp-tool-projection",
      id: "org_1",
      userId: "user_1",
      originInstanceId: "api:origin",
    },
    { scope: "mcp-tool-projection", id: "org_1", originInstanceId: undefined },
  ]);
  expect(
    parseRedisPayload(
      JSON.stringify({ scope: "mcp-tool-projection", id: "org_1", userId: 7 }),
    ),
  ).toBeNull();
});
