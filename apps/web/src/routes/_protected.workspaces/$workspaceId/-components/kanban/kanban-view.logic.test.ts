import { describe, expect, test } from "bun:test";

import {
  getKanbanGroups,
  resolveKanbanGroupOptions,
  selectKanbanRows,
} from "@stll/ui/kanban";
import type { KanbanBoardColumn, KanbanBoardLane } from "@stll/ui/kanban";

import { getInternalPropertyId } from "@/components/workspaces/entity-utils";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

import {
  buildKanbanAssigneeMatrix,
  canMoveCardToSubgroupLane,
  resolveAssigneeLaneDropIntent,
  resolveWorkspaceKanbanAssigneeLaneValues,
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
  assignees: [],
  fields: {},
});

const singleSelectProperty = (id: string): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  kinds: null,
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
  kinds: null,
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

const groupColumnValue = (column: KanbanBoardColumn) =>
  column.type === "group" ? column.group.value : null;
const groupLaneValue = (lane: KanbanBoardLane) =>
  lane.type === "group" ? lane.group.value : null;

describe("kanban assignee subgroup", () => {
  const assigneeSubgroupDefinition = () =>
    resolveWorkspaceKanbanSubgroup(
      getInternalPropertyId("assignee"),
      getInternalPropertyId("status"),
      schemaFor(),
    );

  test("an unassigned row has no lane values", () => {
    const row = entity("task-1", "task");

    expect(resolveWorkspaceKanbanAssigneeLaneValues(row)).toEqual([]);
  });

  test("a two-assignee row's lane values fan out over every assignee", () => {
    const row = entity("task-1", "task");
    row.assignees = [
      { userId: "user-1", name: "Anna Nováková", image: null },
      { userId: "user-2", name: "Petr Svoboda", image: null },
    ];

    expect(resolveWorkspaceKanbanAssigneeLaneValues(row)).toEqual([
      "workspace-user:user-1",
      "workspace-user:user-2",
    ]);
  });

  test("lane options come from the loaded rows, ordered by label", () => {
    const first = entity("task-1", "task");
    first.assignees = [{ userId: "user-2", name: "Petr Svoboda", image: null }];
    const second = entity("task-2", "task");
    second.assignees = [
      {
        userId: "user-1",
        name: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      },
    ];
    const subgroup = resolveWorkspaceKanbanDynamicSubgroup(
      assigneeSubgroupDefinition(),
      [first, second],
    );

    expect(resolveKanbanGroupOptions(subgroup)).toEqual([
      {
        value: "workspace-user:user-1",
        label: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      },
      { value: "workspace-user:user-2", label: "Petr Svoboda", image: null },
    ]);
  });

  test("the group value reports the first assignee, null when unassigned", () => {
    const definition = assigneeSubgroupDefinition();
    const assigned = entity("task-1", "task");
    assigned.assignees = [
      { userId: "user-1", name: "Anna", image: null },
      { userId: "user-2", name: "Petr", image: null },
    ];
    const unassigned = entity("task-2", "task");

    expect(resolveWorkspaceKanbanGroupValue(definition, assigned)).toBe(
      "workspace-user:user-1",
    );
    expect(resolveWorkspaceKanbanGroupValue(definition, unassigned)).toBeNull();
  });

  test("cards may move between assignee lanes unless the task is read-only", () => {
    const definition = assigneeSubgroupDefinition();
    const row = entity("task-1", "task");

    expect(
      canMoveCardToSubgroupLane({
        subgroup: definition,
        entity: row,
        targetLaneValue: "workspace-user:user-9",
      }),
    ).toBe(true);

    row.readOnly = true;
    expect(
      canMoveCardToSubgroupLane({
        subgroup: definition,
        entity: row,
        targetLaneValue: "workspace-user:user-9",
      }),
    ).toBe(false);
  });

  test("a two-assignee row appears in both of its lanes' cells", () => {
    const shared = entity("task-1", "task");
    shared.status = "open";
    shared.assignees = [
      { userId: "user-1", name: "Anna", image: null },
      { userId: "user-2", name: "Petr", image: null },
    ];
    const unassigned = entity("task-2", "task");
    unassigned.status = "open";

    const subgroup = resolveWorkspaceKanbanDynamicSubgroup(
      assigneeSubgroupDefinition(),
      [shared, unassigned],
    );
    const matrix = buildKanbanAssigneeMatrix({
      group: groupingFor(getInternalPropertyId("status")),
      assigneeSubgroup: subgroup,
      rows: [shared, unassigned],
      uncategorizedLabel: "Unassigned",
    });

    const openColumnCells = matrix.cells.filter(
      (cell) => groupColumnValue(cell.coordinate.column) === "open",
    );
    const rowIdsByLane = new Map(
      openColumnCells.map((cell) => [
        groupLaneValue(cell.coordinate.lane),
        cell.rows.map((row) => row.entityId),
      ]),
    );

    expect(rowIdsByLane.get("workspace-user:user-1")).toEqual([
      toSafeId<"entity">("task-1"),
    ]);
    expect(rowIdsByLane.get("workspace-user:user-2")).toEqual([
      toSafeId<"entity">("task-1"),
    ]);
    expect(rowIdsByLane.get(null)).toEqual([toSafeId<"entity">("task-2")]);
    // The row repeats across lane cells, but the board's scoped-row list
    // stays deduplicated: one entry per row.
    expect(matrix.rows.map((row) => row.entityId)).toEqual([
      toSafeId<"entity">("task-1"),
      toSafeId<"entity">("task-2"),
    ]);
  });

  test("drop intent: lane X to lane Y removes X and adds Y", () => {
    expect(
      resolveAssigneeLaneDropIntent(
        "workspace-user:user-1",
        "workspace-user:user-2",
      ),
    ).toEqual({ removeUserId: "user-1", addUserId: "user-2" });
  });

  test("drop intent: Unassigned to Y only adds Y", () => {
    expect(
      resolveAssigneeLaneDropIntent(null, "workspace-user:user-2"),
    ).toEqual({ removeUserId: null, addUserId: "user-2" });
  });

  test("drop intent: X to Unassigned only removes X", () => {
    expect(
      resolveAssigneeLaneDropIntent("workspace-user:user-1", null),
    ).toEqual({ removeUserId: "user-1", addUserId: null });
  });

  test("drop intent: staying in the same lane calls for nothing", () => {
    expect(
      resolveAssigneeLaneDropIntent(
        "workspace-user:user-1",
        "workspace-user:user-1",
      ),
    ).toEqual({ removeUserId: null, addUserId: null });
    expect(resolveAssigneeLaneDropIntent(null, null)).toEqual({
      removeUserId: null,
      addUserId: null,
    });
  });

  test("drop intent: a two-assignee row dragged from its second assignee's lane removes the second, not the first", () => {
    const row = entity("task-1", "task");
    row.assignees = [
      { userId: "user-1", name: "Anna", image: null },
      { userId: "user-2", name: "Petr", image: null },
    ];
    // The card was rendered in (and dragged from) user-2's lane, not the
    // first-assignee lane `resolveWorkspaceKanbanGroupValue` would report.
    const sourceLaneValue = "workspace-user:user-2";

    const intent = resolveAssigneeLaneDropIntent(
      sourceLaneValue,
      "workspace-user:user-3",
    );

    expect(intent).toEqual({ removeUserId: "user-2", addUserId: "user-3" });
    // The row still carries both original assignees until the mutation
    // runs; this only proves the intent never reaches for the first one.
    expect(row.assignees.map((a) => a.userId)).toEqual(["user-1", "user-2"]);
  });
});
