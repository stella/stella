import { describe, expect, test } from "bun:test";

import { resourceMutationDigest } from "@stll/api-contract/realtime-mutation-digest";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  MAX_RESOURCE_CHANGES_PER_EVENT,
  newNotificationRealtimeEvent,
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseResourceMutationId,
  parseUserRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  resourceDeletedRealtimeEvent,
  resourcesChangedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceUpdatedChange,
  resourceUpdatedRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "./realtime-events";
import { RESOURCE_TYPE, resourceRef } from "./resource-ref";
import { toSafeId } from "./safe-id";

const ENTITY_RESOURCE = resourceRef({
  type: RESOURCE_TYPE.ENTITY,
  id: toSafeId<"entity">("entity-1"),
});

const RESOURCE_UPDATED_EVENT = resourceUpdatedRealtimeEvent(ENTITY_RESOURCE);
const RESOURCE_DELETED_EVENT = resourceDeletedRealtimeEvent(ENTITY_RESOURCE);
const RESOURCES_CHANGED_EVENT = resourcesChangedRealtimeEvent([
  resourceUpdatedChange(ENTITY_RESOURCE),
]);
const RESOURCE_SET_UPDATED_EVENT = resourceSetUpdatedRealtimeEvent(
  RESOURCE_TYPE.ENTITY,
);

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
  test("mutation digests follow the SHA-256 UUID contract", async () => {
    expect(
      await resourceMutationDigest("019e7000-0000-7000-8000-0000000000b1"),
    ).toBe("cba7588c0ca99cac5bb1f0818971c997a51b19e0327a2a04a41359c3ca6b5b25");
    expect(
      await resourceMutationDigest("019e7000-0000-7000-8000-0000000000b2"),
    ).not.toBe(
      await resourceMutationDigest("019e7000-0000-7000-8000-0000000000b1"),
    );
    expect(
      await rejectionOf(resourceMutationDigest("invalid-id")),
    ).toHaveProperty("name", "ValiError");
  });

  test("resource facts retain valid mutation correlation and reject malformed digests", async () => {
    const mutationId = "019e7000-0000-7000-8000-0000000000b1";
    const mutationDigest = await resourceMutationDigest(mutationId);
    const events = [
      RESOURCE_UPDATED_EVENT,
      RESOURCE_DELETED_EVENT,
      RESOURCES_CHANGED_EVENT,
      RESOURCE_SET_UPDATED_EVENT,
    ];
    for (const event of events) {
      expect(parseWorkspaceRealtimeEvent({ ...event, mutationDigest })).toEqual(
        {
          ...event,
          mutationDigest,
        },
      );
      for (const invalid of [
        "",
        "unrelated",
        "x".repeat(1000),
        mutationId,
        mutationDigest.toUpperCase(),
        "a".repeat(63),
        "a".repeat(65),
      ]) {
        expect(
          parseWorkspaceRealtimeEvent({ ...event, mutationDigest: invalid }),
        ).toBeNull();
      }
    }
    expect(parseResourceMutationId(mutationId)).toBe(mutationId);
    expect(parseResourceMutationId(null)).toBeUndefined();
    for (const invalid of ["", "unrelated", "x".repeat(1000)]) {
      expect(parseResourceMutationId(invalid)).toBeUndefined();
    }
    expect(
      parseOrganizationRealtimeEvent(
        resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY, mutationDigest),
      ),
    ).toEqual({ ...RESOURCE_SET_UPDATED_EVENT, mutationDigest });
  });

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
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
        resource: { type: "unknown", id: "entity-1" },
      }),
    ).toBeNull();
    expect(
      parseWorkspaceRealtimeEvent({
        type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
        data: { entityId: "entity-1" },
      }),
    ).toBeNull();
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
