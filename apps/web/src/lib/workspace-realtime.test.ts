import { describe, expect, test } from "bun:test";

import { REALTIME_EVENT_TYPE } from "@stll/api-contract";

import {
  getWorkspaceRealtimeQueryKey,
  parseWorkspaceRealtimeMessage,
} from "./workspace-realtime";

describe("workspace realtime policy", () => {
  test("returns the validated query key only for invalidation events", () => {
    const event = parseWorkspaceRealtimeMessage(
      JSON.stringify({
        type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
        data: ["entities", "workspace-1"],
      }),
    );

    expect(event).not.toBeNull();
    if (!event) {
      return;
    }
    expect(getWorkspaceRealtimeQueryKey(event)).toEqual([
      "entities",
      "workspace-1",
    ]);
  });

  test("rejects malformed JSON, unknown events, and invalid query keys", () => {
    expect(parseWorkspaceRealtimeMessage("not-json")).toBeNull();
    expect(
      parseWorkspaceRealtimeMessage(
        JSON.stringify({ type: "unknown", data: null }),
      ),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeMessage(
        JSON.stringify({
          type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
          data: ["entities", 42],
        }),
      ),
    ).toBeNull();
  });

  test("makes non-invalidation event behavior explicit", () => {
    const event = parseWorkspaceRealtimeMessage(
      JSON.stringify({
        type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
        data: {
          runId: "run-1",
          status: "running",
          currentStepIndex: 0,
          steps: [],
        },
      }),
    );

    expect(event).not.toBeNull();
    if (!event) {
      return;
    }
    expect(getWorkspaceRealtimeQueryKey(event)).toBeNull();
  });
});
