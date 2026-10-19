import { describe, expect, expectTypeOf, test } from "bun:test";

import {
  MAX_RESOURCE_CHANGES_PER_EVENT,
  newNotificationRealtimeEvent,
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseUserRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  type RESOURCE_CHANGE_TYPE,
  RESOURCE_DELETION_OWNERSHIP,
  resourceDeletedRealtimeEvent,
  resourceDeletedChange,
  flowRunUpdateRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceUpdatedChange,
  resourceUpdatedRealtimeEvent,
  resourcesChangedRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "./realtime-events";
import { resourceRef, RESOURCE_TYPE } from "./resource-ref";
import { toSafeId } from "./safe-id";

const ENTITY_RESOURCE = resourceRef({
  type: RESOURCE_TYPE.ENTITY,
  id: toSafeId<"entity">("entity-1"),
});

const VIEW_RESOURCE = resourceRef({
  type: RESOURCE_TYPE.WORKSPACE_VIEW,
  id: toSafeId<"workspaceView">("view-1"),
});
const VIEW_DELETION = {
  resource: VIEW_RESOURCE,
  deletionOwnership: RESOURCE_DELETION_OWNERSHIP.ORDINARY,
} as const;
const RESOURCE_UPDATED_EVENT =
  resourceUpdatedRealtimeEvent(ENTITY_RESOURCE).toJSON();
const RESOURCE_DELETED_EVENT =
  resourceDeletedRealtimeEvent(VIEW_DELETION).toJSON();
const RESOURCES_CHANGED_EVENT = resourcesChangedRealtimeEvent([
  resourceUpdatedChange(ENTITY_RESOURCE),
  resourceDeletedChange(VIEW_DELETION),
]).toJSON();
const RESOURCE_SET_UPDATED_EVENT = resourceSetUpdatedRealtimeEvent(
  RESOURCE_TYPE.ENTITY,
).toJSON();

const WORKFLOW_EXTRACTION_PREVIEW_EVENT = {
  type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
  data: {
    entityId: "entity-1",
    entityVersionId: "entity-version-1",
    propertyId: "property-1",
    answer: "Draft answer",
    status: "streaming",
  },
} satisfies WorkspaceRealtimeEvent;

const WORKSPACE_EVENT_FIXTURES = [
  RESOURCE_UPDATED_EVENT,
  RESOURCE_DELETED_EVENT,
  RESOURCES_CHANGED_EVENT,
  RESOURCE_SET_UPDATED_EVENT,
  WORKFLOW_EXTRACTION_PREVIEW_EVENT,
  {
    type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
    data: {
      runId: "run-1",
      status: "running",
      currentStepIndex: 0,
      steps: [{ index: 0, status: "running" }],
    },
  },
] satisfies WorkspaceRealtimeEvent[];

describe("realtime event contracts", () => {
  test("accepts every workspace event kind", () => {
    expect(
      WORKSPACE_EVENT_FIXTURES.map((event) =>
        parseWorkspaceRealtimeEvent(event),
      ),
    ).toEqual(WORKSPACE_EVENT_FIXTURES);
  });

  test("rejects unknown and malformed workspace events", () => {
    expect(
      parseWorkspaceRealtimeEvent({ type: "unknown", data: null }),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.RESOURCES_CHANGED,
        changes: [],
      }),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.RESOURCES_CHANGED,
        changes: Array.from(
          { length: MAX_RESOURCE_CHANGES_PER_EVENT + 1 },
          () => resourceUpdatedChange(ENTITY_RESOURCE),
        ),
      }),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
        resourceType: "unknown",
      }),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
        resource: { type: RESOURCE_TYPE.ENTITY, id: "" },
      }),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent(
        JSON.parse(
          '{"type":"resource.deleted","resource":{"type":"unknown","id":"entity-1"}}',
        ),
      ),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
        data: { entityId: "entity-1" },
      }),
    ).toBeNull();
  });

  test("requires a named ownership classification for every entity deletion", () => {
    const validMessages = [
      '{"type":"resource.deleted","resource":{"type":"entity","id":"entity-1"},"deletionOwnership":"ordinary"}',
      '{"type":"resource.deleted","resource":{"type":"entity","id":"entity-1"},"deletionOwnership":"flow-review-task"}',
      '{"type":"resources.changed","changes":[{"change":"deleted","resource":{"type":"entity","id":"entity-1"},"deletionOwnership":"ordinary"}]}',
      '{"type":"resources.changed","changes":[{"change":"deleted","resource":{"type":"entity","id":"entity-1"},"deletionOwnership":"flow-review-task"}]}',
    ];
    for (const message of validMessages) {
      const wire = JSON.parse(message);
      expect(parseWorkspaceRealtimeEvent(wire)).toEqual(wire);
    }
    const invalidMessages = [
      '{"type":"resource.deleted","resource":{"type":"entity","id":"entity-1"}}',
      '{"type":"resource.deleted","resource":{"type":"entity","id":"entity-1"},"deletionOwnership":"unknown"}',
      '{"type":"resources.changed","changes":[{"change":"deleted","resource":{"type":"entity","id":"entity-1"}}]}',
      '{"type":"resources.changed","changes":[{"change":"deleted","resource":{"type":"entity","id":"entity-1"},"deletionOwnership":"unknown"}]}',
    ];
    for (const message of invalidMessages) {
      expect(parseWorkspaceRealtimeEvent(JSON.parse(message))).toBeNull();
    }
  });

  test("limits organization events to organization-safe kinds", () => {
    expect(parseOrganizationRealtimeEvent(RESOURCE_UPDATED_EVENT)).toBeNull();
    expect(parseOrganizationRealtimeEvent(RESOURCE_DELETED_EVENT)).toBeNull();
    expect(parseOrganizationRealtimeEvent(RESOURCES_CHANGED_EVENT)).toBeNull();
    expect(parseOrganizationRealtimeEvent(RESOURCE_SET_UPDATED_EVENT)).toEqual(
      RESOURCE_SET_UPDATED_EVENT,
    );
    expect(
      parseOrganizationRealtimeEvent(WORKFLOW_EXTRACTION_PREVIEW_EVENT),
    ).toBeNull();
  });

  test("validates desktop session client events and the close signal", () => {
    expect(
      parseDesktopEditSessionRealtimeEvent({
        type: REALTIME_EVENT_TYPE.TAKEOVER_REQUESTED,
        data: {
          requestedBy: "Another user",
          requestedAt: "2026-08-08T12:00:00.000Z",
        },
      }),
    ).not.toBeNull();
    expect(
      parseDesktopEditSessionRealtimeEvent({
        type: REALTIME_EVENT_TYPE.DESKTOP_EDIT_SESSION_CLOSED,
        data: null,
      }),
    ).not.toBeNull();
    expect(
      parseDesktopEditSessionRealtimeEvent({
        type: REALTIME_EVENT_TYPE.SESSION_TAKEN_OVER,
        data: {},
      }),
    ).toBeNull();
    expect(
      parseDesktopEditSessionRealtimeEvent({
        type: REALTIME_EVENT_TYPE.TAKEOVER_REQUESTED,
        data: {
          requestedBy: "Another user",
          requestedAt: "not-a-timestamp",
        },
      }),
    ).toBeNull();
  });
});

describe("user realtime events", () => {
  test("the notification event carries no notification", () => {
    const event = newNotificationRealtimeEvent();

    // The user channel fans out to every tab a person has open, including
    // tabs on another organization. It must therefore never carry a row id,
    // kind or metadata: the client re-reads through the authorized endpoint.
    expect(event).toEqual({
      type: REALTIME_EVENT_TYPE.NEW_NOTIFICATION,
      data: null,
    });
    expect(Object.keys(event)).toEqual(["type", "data"]);
  });

  test("refuses a payload that smuggles a notification in", () => {
    expect(
      parseUserRealtimeEvent({
        type: REALTIME_EVENT_TYPE.NEW_NOTIFICATION,
        data: { id: "notification-1", kind: "mention" },
      }),
    ).toBeNull();
    expect(parseUserRealtimeEvent(newNotificationRealtimeEvent())).toEqual(
      newNotificationRealtimeEvent(),
    );
  });

  test("the user channel does not accept workspace events", () => {
    expect(parseUserRealtimeEvent(RESOURCE_UPDATED_EVENT)).toBeNull();
    expect(parseUserRealtimeEvent(RESOURCE_SET_UPDATED_EVENT)).toBeNull();
  });

  test("the workspace channel does not accept the notification event", () => {
    expect(
      parseWorkspaceRealtimeEvent(newNotificationRealtimeEvent()),
    ).toBeNull();
  });
});

test("entity deletion builders require proven ownership while views use explicit labels", () => {
  type UnclassifiedEntityDeletion = {
    resource: typeof ENTITY_RESOURCE;
    deletionOwnership: typeof RESOURCE_DELETION_OWNERSHIP.ORDINARY;
  };
  expectTypeOf<
    UnclassifiedEntityDeletion extends Parameters<
      typeof resourceDeletedRealtimeEvent
    >[0]
      ? true
      : false
  >().toEqualTypeOf<false>();
  expectTypeOf<
    UnclassifiedEntityDeletion extends Parameters<
      typeof resourceDeletedChange
    >[0]
      ? true
      : false
  >().toEqualTypeOf<false>();

  expectTypeOf<
    UnclassifiedEntityDeletion & {
      change: typeof RESOURCE_CHANGE_TYPE.DELETED;
    } extends Parameters<typeof resourcesChangedRealtimeEvent>[0][number]
      ? true
      : false
  >().toEqualTypeOf<false>();

  const deletion = {
    resource: resourceRef({
      type: RESOURCE_TYPE.WORKSPACE_VIEW,
      id: toSafeId<"workspaceView">("view-1"),
    }),
    deletionOwnership: RESOURCE_DELETION_OWNERSHIP.ORDINARY,
  } as const;
  expect(resourceDeletedRealtimeEvent(deletion).toJSON()).toEqual(
    RESOURCE_DELETED_EVENT,
  );
  const change = resourceDeletedChange(deletion);
  expect(change).toMatchObject(deletion);
  expect(resourcesChangedRealtimeEvent([change]).toJSON()).toEqual({
    type: REALTIME_EVENT_TYPE.RESOURCES_CHANGED,
    changes: [change],
  });
});

test("producer capabilities snapshot inputs and return detached wire projections", () => {
  const data = flowRunUpdateRealtimeEvent({
    runId: "run-1",
    status: "running",
    currentStepIndex: 0,
    steps: [],
  }).toJSON().data;
  const built = flowRunUpdateRealtimeEvent(data);
  data.runId = "modified-input";
  expect(built.toJSON().data.runId).toBe("run-1");
  const first = built.toJSON();
  first.data.runId = "modified";
  expect(built.toJSON().data.runId).toBe("run-1");
  const message = JSON.stringify(built);
  expect(parseWorkspaceRealtimeEvent(JSON.parse(message))).toEqual(
    built.toJSON(),
  );
  const replacement = flowRunUpdateRealtimeEvent({ ...data, runId: "forged" });
  expect(() => Object.assign(built, { toJSON: replacement.toJSON })).toThrow(
    TypeError,
  );
  expect(built.toJSON().data.runId).toBe("run-1");
});
