import { describe, expect, test } from "bun:test";

import {
  getKanbanGroups,
  resolveKanbanGroupOptions,
  selectKanbanRows,
} from "@stll/ui/kanban";

import { getInternalPropertyId } from "@/components/workspaces/entity-utils";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

import {
  canMoveCardToSubgroupLane,
  resolveWorkspaceKanbanDynamicSubgroup,
  resolveWorkspaceKanbanGrouping,
  resolveWorkspaceKanbanGroupValue,
  resolveWorkspaceKanbanSubgroup,
  workspaceKanbanSchema,
} from "./kanban-view.logic";

const entity = (
  entityId: string,
  kind: WorkspaceEntity["kind"],
): WorkspaceEntity => ({
  entityId: toSafeId<"entity">(entityId),
  kind,
  name: entityId,
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  createdByUserId: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  status: kind === "task" ? "open" : null,
  priority: null,
  listItemType: "task",
  dueDate: null,
  agendaKind: "task",
  startAt: null,
  endAt: null,
  occurredAt: null,
  remindAt: null,
  allDay: false,
  timeZone: null,
  location: null,
  onlineMeetingUrl: null,
  availability: null,
  sensitivity: null,
  organizer: null,
  attendees: null,
  recurrence: null,
  agendaSource: "manual",
  externalSource: null,
  externalId: null,
  externalChangeKey: null,
  externalICalUid: null,
  readOnly: false,
  sortOrder: null,
  activeEditBy: null,
  cellMetadata: {},
  fields: {},
});

const singleSelectProperty = (id: string): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  content: {
    version: 1,
    type: "single-select",
    options: [],
    fallback: null,
  },
  tool: { version: 1, type: "manual-input" },
});

const personProperty = (id: string): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  content: { version: 1, type: "person" },
  tool: { version: 1, type: "manual-input" },
});

const STATUS_LABELS = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

const ENTITY_KIND_LABELS = {
  document: "Document",
  folder: "Folder",
  task: "Task",
  message: "Message",
  link: "Link",
};

const schemaFor = (properties: WorkspaceProperty[] = []) =>
  workspaceKanbanSchema({
    properties,
    statusLabels: STATUS_LABELS,
    entityKindLabels: ENTITY_KIND_LABELS,
  });

const groupingFor = (groupBy: string, properties: WorkspaceProperty[] = []) =>
  resolveWorkspaceKanbanGrouping(groupBy, schemaFor(properties));

describe("kanban grouping entity scope", () => {
  test("kind grouping keeps matter documents and folders", () => {
    const grouping = groupingFor(getInternalPropertyId("kind"));
    const result = selectKanbanRows(
      [
        entity("document-1", "document"),
        entity("folder-1", "folder"),
        entity("task-1", "task"),
      ],
      grouping,
    );

    expect(result.map((row) => row.kind)).toEqual([
      "document",
      "folder",
      "task",
    ]);
  });

  test("status grouping is task-only", () => {
    const grouping = groupingFor(getInternalPropertyId("status"));
    const result = selectKanbanRows(
      [entity("document-1", "document"), entity("task-1", "task")],
      grouping,
    );

    expect(result.map((row) => row.kind)).toEqual(["task"]);
  });

  test("custom property grouping keeps matter entities", () => {
    const grouping = groupingFor("phase", [singleSelectProperty("phase")]);
    const result = selectKanbanRows(
      [entity("document-1", "document"), entity("task-1", "task")],
      grouping,
    );

    expect(grouping.type).toBe("property");
    expect(result.map((row) => row.kind)).toEqual(["document", "task"]);
  });
});

describe("kanban column lists", () => {
  test("a status board draws the five task statuses, then uncategorized", () => {
    const grouping = groupingFor(getInternalPropertyId("status"));
    const groups = getKanbanGroups(
      resolveKanbanGroupOptions(grouping),
      "Uncategorized",
    );

    expect(groups.map((group) => [group.value, group.label])).toEqual([
      ["open", "Open"],
      ["in_progress", "In progress"],
      ["in_review", "In review"],
      ["done", "Done"],
      ["cancelled", "Cancelled"],
      [null, "Uncategorized"],
    ]);
  });

  test("status columns carry the palette colour their tier is defined with", () => {
    const options = resolveKanbanGroupOptions(
      groupingFor(getInternalPropertyId("status")),
    );

    expect(options.map((option) => option.optionColor)).toEqual([
      "gray",
      "blue",
      "amber",
      "green",
      "red",
    ]);
  });

  test("a kind board draws every entity kind", () => {
    const options = resolveKanbanGroupOptions(
      groupingFor(getInternalPropertyId("kind")),
    );

    expect(options.map((option) => option.value)).toEqual([
      "document",
      "folder",
      "task",
      "message",
      "link",
    ]);
  });

  test("a created-by board has no column list, so it cannot be drawn", () => {
    const grouping = groupingFor(getInternalPropertyId("created-by"));

    expect(grouping.type).toBe("built-in");
    expect(resolveKanbanGroupOptions(grouping)).toEqual([]);
  });

  test("a select property's columns are its options, in the property's order", () => {
    const property = singleSelectProperty("phase");
    const withOptions: WorkspaceProperty = {
      ...property,
      content: {
        version: 1,
        type: "single-select",
        options: [
          { value: "draft", color: "gray" },
          { value: "review", color: "amber" },
        ],
        fallback: null,
      },
    };

    const options = resolveKanbanGroupOptions(
      groupingFor("phase", [withOptions]),
    );

    expect(options.map((option) => [option.value, option.optionColor])).toEqual(
      [
        ["draft", "gray"],
        ["review", "amber"],
      ],
    );
  });
});

describe("kanban subgroup placement", () => {
  test("read-only subgroup lanes allow primary moves only within the lane", () => {
    const row = entity("task-1", "task");
    row.createdBy = "Anna Nováková";
    row.createdByUserId = "user-1";
    const definition = resolveWorkspaceKanbanSubgroup(
      getInternalPropertyId("created-by"),
      getInternalPropertyId("status"),
      schemaFor(),
    );
    const subgroup = resolveWorkspaceKanbanDynamicSubgroup(definition, [row]);

    expect(
      canMoveCardToSubgroupLane({
        subgroup,
        entity: row,
        targetLaneValue: "workspace-user:user-1",
      }),
    ).toBe(true);
    expect(
      canMoveCardToSubgroupLane({
        subgroup,
        entity: row,
        targetLaneValue: "workspace-user:user-2",
      }),
    ).toBe(false);
  });

  test("the same property cannot control both axes", () => {
    const property = singleSelectProperty("assignee");
    const schema = schemaFor([property]);
    const group = resolveWorkspaceKanbanGrouping(property.id, schema);
    const subgroup = resolveWorkspaceKanbanSubgroup(
      property.id,
      property.id,
      schema,
    );

    expect(group.type).toBe("property");
    expect(subgroup.type).toBe("none");
  });

  test("a single-select field places a task in its colleague lane", () => {
    const property = singleSelectProperty("assignee");
    const row = entity("task-1", "task");
    row.fields[property.id] = {
      entityId: row.entityId,
      id: toSafeId<"field">("field-1"),
      propertyId: property.id,
      content: {
        version: 1,
        type: "single-select",
        value: "Anna Nováková",
      },
    };
    const subgroup = resolveWorkspaceKanbanSubgroup(
      property.id,
      getInternalPropertyId("status"),
      schemaFor([property]),
    );

    expect(resolveWorkspaceKanbanGroupValue(subgroup, row)).toBe(
      "Anna Nováková",
    );
  });

  test("person lanes preserve member identity and avatar", () => {
    const property = personProperty("assignee");
    const row = entity("task-1", "task");
    row.fields[property.id] = {
      entityId: row.entityId,
      id: toSafeId<"field">("field-1"),
      propertyId: property.id,
      content: {
        version: 1,
        type: "person",
        userId: "user-1",
        name: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      },
    };
    const definition = resolveWorkspaceKanbanSubgroup(
      property.id,
      getInternalPropertyId("status"),
      schemaFor([property]),
    );
    const subgroup = resolveWorkspaceKanbanDynamicSubgroup(definition, [row]);

    expect(resolveKanbanGroupOptions(subgroup)).toEqual([
      {
        value: "workspace-user:user-1",
        label: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      },
    ]);
    expect(resolveWorkspaceKanbanGroupValue(subgroup, row)).toBe(
      "workspace-user:user-1",
    );
  });

  test("author lanes use the creator avatar instead of a decorative dot", () => {
    const row = entity("task-1", "task");
    row.createdBy = "Anna Nováková";
    row.createdByUserId = "user-1";
    row.createdByImage = "https://example.test/anna.jpg";
    const definition = resolveWorkspaceKanbanSubgroup(
      getInternalPropertyId("created-by"),
      getInternalPropertyId("status"),
      schemaFor(),
    );
    const subgroup = resolveWorkspaceKanbanDynamicSubgroup(definition, [row]);

    expect(resolveKanbanGroupOptions(subgroup)).toEqual([
      {
        value: "workspace-user:user-1",
        label: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      },
    ]);
  });

  test("author lanes keep users with the same display name separate", () => {
    const first = entity("task-1", "task");
    first.createdBy = "Anna Nováková";
    first.createdByUserId = "user-1";
    const second = entity("task-2", "task");
    second.createdBy = "Anna Nováková";
    second.createdByUserId = "user-2";
    const definition = resolveWorkspaceKanbanSubgroup(
      getInternalPropertyId("created-by"),
      getInternalPropertyId("status"),
      schemaFor(),
    );
    const subgroup = resolveWorkspaceKanbanDynamicSubgroup(definition, [
      first,
      second,
    ]);

    expect(
      resolveKanbanGroupOptions(subgroup).map(({ value }) => value),
    ).toEqual(["workspace-user:user-1", "workspace-user:user-2"]);
    expect(resolveWorkspaceKanbanGroupValue(subgroup, first)).toBe(
      "workspace-user:user-1",
    );
    expect(resolveWorkspaceKanbanGroupValue(subgroup, second)).toBe(
      "workspace-user:user-2",
    );
  });
});
