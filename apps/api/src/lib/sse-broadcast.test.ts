import { describe, expect, test } from "bun:test";

import { REALTIME_EVENT_TYPE } from "@stll/api-contract";

import { parseRedisPayload } from "@/api/lib/sse-broadcast";

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
          type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
          data: ["organizations"],
        }),
      )?.scope,
    ).toBe("organization");
    expect(
      parseRedisPayload(
        redisPayload("session", {
          type: REALTIME_EVENT_TYPE.SESSION_CLOSED,
          data: { reason: "expired" },
        }),
      )?.scope,
    ).toBe("session");
  });

  test("rejects events that are malformed or invalid for their scope", () => {
    expect(
      parseRedisPayload(
        redisPayload("workspace", {
          type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
          data: ["entities", 42],
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
        redisPayload("session", {
          type: REALTIME_EVENT_TYPE.SESSION_TAKEN_OVER,
          data: {},
        }),
      ),
    ).toBeNull();
  });
});
