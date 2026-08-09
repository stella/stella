import { describe, expect, test } from "bun:test";

import {
  MAX_RESOURCE_CHANGES_PER_EVENT,
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  resourceDeletedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceUpdatedChange,
  resourceUpdatedRealtimeEvent,
  resourcesChangedRealtimeEvent,
  type OrganizationRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "./realtime-events";
import { resourceRef, RESOURCE_TYPE } from "./resource-ref";
import { toSafeId } from "./safe-id";

const INVALIDATE_QUERY_EVENT = {
  type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
  data: ["entities", "workspace-1"],
} satisfies OrganizationRealtimeEvent;

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
  INVALIDATE_QUERY_EVENT,
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
        type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
        data: [],
      }),
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
        type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY,
        data: ["entities", 42],
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
    expect(parseOrganizationRealtimeEvent(INVALIDATE_QUERY_EVENT)).toEqual(
      INVALIDATE_QUERY_EVENT,
    );
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
