import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { getInternalPropertyId } from "@/components/workspaces/internal-ids.logic";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import {
  KANBAN_BOARD_CLASS,
  KANBAN_COLUMN_CLASS,
  KanbanViewPending,
  pendingKanbanColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.pending";

const phase: WorkspaceProperty = {
  id: toSafeId<"property">("phase"),
  name: "Phase",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  kinds: null,
  content: {
    version: 1,
    type: "single-select",
    options: [
      { value: "Draft", color: "blue" },
      { value: "Signed", color: "green" },
    ],
    fallback: null,
  },
  tool: { version: 1, type: "manual-input" },
};

const notes: WorkspaceProperty = {
  ...phase,
  id: toSafeId<"property">("notes"),
  name: "Notes",
  content: { version: 1, type: "text" },
};

const board = (
  layout: Partial<WorkspaceView<"kanban">["layout"]> = {},
): WorkspaceView => ({
  version: 1,
  id: "view-1",
  name: "Board",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "kanban",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    ...layout,
  },
});

const values = (columns: ReturnType<typeof pendingKanbanColumns>) =>
  columns?.map((column) => column.value) ?? null;

describe("a loading board's columns", () => {
  test("are the grouping property's options in order, then the uncategorized column", () => {
    expect(
      values(
        pendingKanbanColumns({
          properties: [phase],
          view: board({ groupByPropertyId: "phase" }),
        }),
      ),
    ).toEqual(["Draft", "Signed", null]);
  });

  test("follow the board's default grouping when the view names none", () => {
    expect(
      values(pendingKanbanColumns({ properties: [phase], view: board() })),
    ).toEqual(["Draft", "Signed", null]);
  });

  test("are the task statuses on a status board", () => {
    expect(
      values(
        pendingKanbanColumns({
          properties: [],
          view: board({ groupByPropertyId: getInternalPropertyId("status") }),
        }),
      ),
    ).toEqual(["open", "in_progress", "in_review", "done", "cancelled", null]);
  });

  test("are not claimed for a board the cached view cannot lay out", () => {
    // A sub-grouped board draws lanes from loaded rows; a grouping the board
    // cannot draw shows its empty state instead of columns.
    expect(
      pendingKanbanColumns({
        properties: [phase],
        view: board({
          groupByPropertyId: "phase",
          subgroupByPropertyId: getInternalPropertyId("assignee"),
        }),
      }),
    ).toBeNull();
    expect(
      pendingKanbanColumns({
        properties: [notes],
        view: board({ groupByPropertyId: "notes" }),
      }),
    ).toBeNull();
    expect(
      pendingKanbanColumns({
        properties: [],
        view: board({ groupByPropertyId: getInternalPropertyId("created-by") }),
      }),
    ).toBeNull();
  });
});

describe("a loading board", () => {
  test("draws one column frame per column in the board's frame, with nothing to focus", () => {
    const markup = renderToStaticMarkup(
      <KanbanViewPending
        properties={[phase]}
        view={board({ groupByPropertyId: "phase" })}
      />,
    );
    expect(markup).toContain(`class="${KANBAN_BOARD_CLASS}"`);
    expect(markup.split(KANBAN_COLUMN_CLASS).length - 1).toBe(3);
    expect(markup).toContain("color-mix(in srgb");
    expect(markup).not.toMatch(/<(button|input|a)\b|tabindex=/u);
  });

  test("draws nothing where the cached view cannot say what the board is", () => {
    expect(
      renderToStaticMarkup(
        <KanbanViewPending
          properties={[notes]}
          view={board({ groupByPropertyId: "notes" })}
        />,
      ),
    ).toBe("");
  });
});
