import { describe, expect, test } from "bun:test";

import {
  buildKanbanBoardMatrix,
  getKanbanGroupingPropertyId,
} from "@stll/ui/kanban";
import type { KanbanBuiltInGroup } from "@stll/ui/kanban";

import {
  createWorkspaceKanbanSchema,
  getWorkspaceKanbanGroupingChoices,
  normalizeKanbanSavedViewState,
  presentKanbanBoard,
  resolveWorkspaceKanbanView,
} from "./kanban-view";
import type {
  KanbanSavedViewState,
  KanbanSavedViewStateV1,
  WorkspaceKanbanProperty,
} from "./kanban-view";

type Row = { id: string; owner: string | null; status: string | null };
type GroupId = "_status" | "owner";

const properties: WorkspaceKanbanProperty<GroupId>[] = [
  {
    content: {
      options: [
        { color: "blue", value: "ada" },
        { color: "green", value: "lin" },
      ],
      type: "single-select",
    },
    id: "owner",
    name: "Owner",
  },
];

const schema = createWorkspaceKanbanSchema({
  builtInGroups: [
    {
      id: "_status",
      options: [
        { label: "Open", value: "open" },
        { label: "Done", value: "done" },
      ],
      selectRows: (rows: readonly Row[]) => [...rows],
    },
  ],
  properties,
});

const state: KanbanSavedViewState<GroupId> = {
  group: {
    collapsedBands: [],
    emptyGroups: "hide",
    groupBy: "_status",
    hiddenGroups: [],
    orderedGroups: [{ type: "option", value: "done" }],
  },
  subgroup: {
    collapsedGroups: [{ type: "option", value: "ada" }],
    emptyGroups: "hide",
    groupBy: "owner",
    hiddenGroups: [],
    orderedGroups: [{ type: "option", value: "lin" }],
  },
  version: 2,
};

describe("workspace kanban view adapter", () => {
  test("derives picker choices from built-in groups and authoritative property options", () => {
    expect(
      getWorkspaceKanbanGroupingChoices({
        getBuiltInGroupLabel: () => "Status",
        schema,
      }),
    ).toEqual([
      { id: "_status", label: "Status", type: "built-in" },
      { id: "owner", label: "Owner", type: "property" },
    ]);
  });

  test("keeps group and subgroup independently persisted and presents ordered, collapsed lanes", () => {
    const view = resolveWorkspaceKanbanView({ schema, state });
    const groupBy: GroupId | null = getKanbanGroupingPropertyId(view.group);
    const matrix = buildKanbanBoardMatrix({
      group: view.group,
      resolveGroupValue: ({
        grouping,
        row,
      }: {
        grouping: typeof view.group;
        row: Row;
      }) => {
        switch (grouping.type) {
          case "built-in":
            return row.status;
          case "property":
            return row.owner;
          case "none":
            return null;
          default: {
            const exhaustive: never = grouping;
            return exhaustive;
          }
        }
      },
      rows: [{ id: "one", owner: "ada", status: "open" }],
      subgroup: view.subgroup,
      uncategorizedLabel: "No value",
    });
    const presentation = presentKanbanBoard({ matrix, state });

    expect(groupBy).toBe("_status");
    expect(
      presentation.columns
        .filter((column) => column.type === "group")
        .map((column) => column.group.value),
    ).toEqual(["open"]);
    expect(
      presentation.lanes.map((lane) => ({
        collapsed: lane.collapsed,
        value: lane.lane.type === "group" ? lane.lane.group.value : null,
      })),
    ).toEqual([{ collapsed: true, value: "ada" }]);
    expect(presentation.matrix.cells.flatMap((cell) => cell.rows)).toEqual([
      { id: "one", owner: "ada", status: "open" },
    ]);
    expect(presentation.bands).toEqual([
      { band: null, collapsed: false, columns: presentation.columns },
    ]);
  });

  test("lifts a version 1 view state with no band folded", () => {
    const legacy: KanbanSavedViewStateV1<GroupId> = {
      group: {
        emptyGroups: "show",
        groupBy: "_status",
        hiddenGroups: [{ type: "uncategorized" }],
        orderedGroups: [],
      },
      subgroup: null,
      version: 1,
    };

    expect(normalizeKanbanSavedViewState(legacy)).toEqual({
      group: { ...legacy.group, collapsedBands: [] },
      subgroup: null,
      version: 2,
    });
    expect(normalizeKanbanSavedViewState(state)).toBe(state);
  });

  test("carries option bands into columns and folds the bands the view collapsed", () => {
    const todo = { id: "todo", label: "To do" };
    const noBuiltInGroups: readonly KanbanBuiltInGroup<Row, GroupId>[] = [];
    const bandedSchema = createWorkspaceKanbanSchema({
      builtInGroups: noBuiltInGroups,
      properties: [
        {
          content: {
            options: [
              { band: todo, color: "blue", value: "open" },
              { band: todo, color: "blue", value: "blocked" },
              { color: "green", value: "done" },
            ],
            type: "single-select",
          },
          id: "_status",
          name: "Status",
        },
      ] satisfies WorkspaceKanbanProperty<GroupId>[],
    });
    const bandedState: KanbanSavedViewState<GroupId> = {
      group: {
        collapsedBands: ["todo"],
        emptyGroups: "show",
        groupBy: "_status",
        hiddenGroups: [],
        orderedGroups: [],
      },
      subgroup: null,
      version: 2,
    };
    const view = resolveWorkspaceKanbanView({
      schema: bandedSchema,
      state: bandedState,
    });
    const matrix = buildKanbanBoardMatrix({
      group: view.group,
      resolveGroupValue: ({ row }: { row: Row }) => row.status,
      rows: [{ id: "one", owner: null, status: "blocked" }],
      subgroup: view.subgroup,
      uncategorizedLabel: "No value",
    });
    const presentation = presentKanbanBoard({ matrix, state: bandedState });

    expect(
      presentation.bands.map((span) => [
        span.band?.id ?? null,
        span.collapsed,
        span.columns.map((column) =>
          column.type === "group" ? column.group.value : column.destination.id,
        ),
      ]),
    ).toEqual([
      ["todo", true, ["open", "blocked"]],
      [null, false, ["done"]],
      [null, false, [null]],
    ]);
  });

  test("does not permit one source to drive both axes", () => {
    const duplicateAxisState: KanbanSavedViewState = {
      ...state,
      subgroup: { ...state.group, collapsedGroups: [] },
    };

    expect(
      resolveWorkspaceKanbanView({ schema, state: duplicateAxisState })
        .subgroup,
    ).toEqual({
      type: "none",
    });
  });

  test("deduplicates stale persisted ordering before presenting lanes", () => {
    if (state.subgroup === null) {
      throw new Error("fixture must define subgroup state");
    }
    const duplicateOrderingState: KanbanSavedViewState = {
      ...state,
      subgroup: {
        ...state.subgroup,
        orderedGroups: [
          { type: "option", value: "ada" },
          { type: "option", value: "ada" },
        ],
      },
    };
    const view = resolveWorkspaceKanbanView({
      schema,
      state: duplicateOrderingState,
    });
    const matrix = buildKanbanBoardMatrix({
      group: view.group,
      resolveGroupValue: ({ grouping, row }) => {
        switch (grouping.type) {
          case "built-in":
            return row.status;
          case "property":
            return row.owner;
          case "none":
            return null;
          default: {
            const exhaustive: never = grouping;
            return exhaustive;
          }
        }
      },
      rows: [{ id: "one", owner: "ada", status: "open" }],
      subgroup: view.subgroup,
      uncategorizedLabel: "No value",
    });
    const presentation = presentKanbanBoard({
      matrix,
      state: duplicateOrderingState,
    });

    expect(
      presentation.lanes.map((lane) =>
        lane.lane.type === "group" ? lane.lane.group.value : null,
      ),
    ).toEqual(["ada"]);
    expect(presentation.lanes.flatMap((lane) => lane.cells)).toHaveLength(1);
  });
});
