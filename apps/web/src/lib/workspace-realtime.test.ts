import { describe, expect, test } from "bun:test";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";

import {
  getWorkspaceRealtimeQueryActions,
  parseWorkspaceRealtimeMessage,
  WORKSPACE_REALTIME_QUERY_ACTION,
} from "./workspace-realtime";

const WORKSPACE_ID = "workspace-1";

const parseEvent = (value: unknown) =>
  parseWorkspaceRealtimeMessage(JSON.stringify(value));

describe("workspace realtime policy", () => {
  test("preserves legacy query-key invalidations during migration", () => {
    const event = parseEvent({
      type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
      data: ["entities", WORKSPACE_ID],
    });

    expect(event).not.toBeNull();
    if (!event) {
      return;
    }
    expect(getWorkspaceRealtimeQueryActions(event, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
    ]);
  });

  test("maps entity updates and deletions without producer-owned query keys", () => {
    const updated = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-1" },
    });
    const deleted = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: "entity-1" },
    });

    expect(updated).not.toBeNull();
    expect(deleted).not.toBeNull();
    if (!(updated && deleted)) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(updated, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
    ]);
    expect(getWorkspaceRealtimeQueryActions(deleted, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX,
        queryKey: ["entities", WORKSPACE_ID, "entity-1"],
      },
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["entities", WORKSPACE_ID],
      },
    ]);
  });

  test("maps view changes and explicitly ignores resources without a policy", () => {
    const view = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.WORKSPACE_VIEW, id: "view-1" },
    });
    const contact = parseEvent({
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.CONTACT, id: "contact-1" },
    });

    expect(view).not.toBeNull();
    expect(contact).not.toBeNull();
    if (!(view && contact)) {
      return;
    }

    expect(getWorkspaceRealtimeQueryActions(view, WORKSPACE_ID)).toEqual([
      {
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: ["views", WORKSPACE_ID],
      },
    ]);
    expect(getWorkspaceRealtimeQueryActions(contact, WORKSPACE_ID)).toEqual([]);
  });

  test("rejects malformed JSON, unknown events, query keys, and resources", () => {
    expect(parseWorkspaceRealtimeMessage("not-json")).toBeNull();
    expect(parseEvent({ type: "unknown", data: null })).toBeNull();
    expect(
      parseEvent({
        type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
        data: ["entities", 42],
      }),
    ).toBeNull();
    expect(
      parseEvent({
        type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
        resource: { type: RESOURCE_TYPE.ENTITY, id: "" },
      }),
    ).toBeNull();
  });

  test("makes non-invalidation event behavior explicit", () => {
    const event = parseEvent({
      type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
      data: {
        runId: "run-1",
        status: "running",
        currentStepIndex: 0,
        steps: [],
      },
    });

    expect(event).not.toBeNull();
    if (!event) {
      return;
    }
    expect(getWorkspaceRealtimeQueryActions(event, WORKSPACE_ID)).toEqual([]);
  });
});
