import { describe, expect, test } from "bun:test";

import { buildKanbanBoardMatrix } from "@stll/ui/kanban";

import {
  createWorkspaceKanbanSchema,
  getWorkspaceKanbanGroupingChoices,
  presentKanbanBoard,
  resolveWorkspaceKanbanView,
} from "./kanban-view";
import type {
  KanbanSavedViewState,
  WorkspaceKanbanProperty,
} from "./kanban-view";

type Row = { id: string; owner: string | null; status: string | null };

const properties: WorkspaceKanbanProperty[] = [
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

const state: KanbanSavedViewState = {
  group: {
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
  version: 1,
};

describe("workspace kanban view adapter", () => {
  test("derives picker choices from built-in groups and authoritative property options", () => {
    expect(getWorkspaceKanbanGroupingChoices({ schema })).toEqual([
      { id: "_status", label: "_status", type: "built-in" },
      { id: "owner", label: "Owner", type: "property" },
    ]);
  });

  test("keeps group and subgroup independently persisted and presents ordered, collapsed lanes", () => {
    const view = resolveWorkspaceKanbanView({ schema, state });
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

    expect(presentation.columns.map((column) => column.value)).toEqual([
      "open",
    ]);
    expect(
      presentation.lanes.map((lane) => ({
        collapsed: lane.collapsed,
        value: lane.lane.type === "group" ? lane.lane.group.value : null,
      })),
    ).toEqual([{ collapsed: true, value: "ada" }]);
    expect(presentation.matrix.cells.flatMap((cell) => cell.rows)).toEqual([
      { id: "one", owner: "ada", status: "open" },
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
});
