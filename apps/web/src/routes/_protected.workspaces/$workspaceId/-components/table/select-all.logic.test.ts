import { describe, expect, test } from "bun:test";

import {
  getNextSelectAllRowSelection,
  getSelectAllState,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/select-all.logic";

describe("workspace table select-all state", () => {
  test("is unchecked when no selectable rows are selected", () => {
    expect(
      getSelectAllState({
        selectableRowIds: ["row-1", "row-2"],
        rowSelection: {},
      }),
    ).toEqual({
      checked: false,
      indeterminate: false,
      key: "none",
    });
  });

  test("is indeterminate when only some selectable rows are selected", () => {
    expect(
      getSelectAllState({
        selectableRowIds: ["row-1", "row-2"],
        rowSelection: { "row-1": true },
      }),
    ).toEqual({
      checked: false,
      indeterminate: true,
      key: "some",
    });
  });

  test("is checked only when every selectable row is selected", () => {
    expect(
      getSelectAllState({
        selectableRowIds: ["row-1", "row-2"],
        rowSelection: { "row-1": true, "row-2": true },
      }),
    ).toEqual({
      checked: true,
      indeterminate: false,
      key: "all",
    });
  });

  test("ignores stale selected ids that are no longer selectable rows", () => {
    expect(
      getSelectAllState({
        selectableRowIds: ["row-1", "row-2"],
        rowSelection: { "deleted-row": true },
      }),
    ).toEqual({
      checked: false,
      indeterminate: false,
      key: "none",
    });
  });

  test("select-all selects each selectable row", () => {
    expect(
      getNextSelectAllRowSelection({
        selectableRowIds: ["row-1", "row-2"],
        rowSelection: {},
      }),
    ).toEqual({ "row-1": true, "row-2": true });
  });

  test("unselect-all clears stale selected ids too", () => {
    expect(
      getNextSelectAllRowSelection({
        selectableRowIds: ["row-1", "row-2"],
        rowSelection: {
          "deleted-row": true,
          "row-1": true,
          "row-2": true,
        },
      }),
    ).toEqual({});
  });

  test("does not require hidden descendant rows to mark visible rows selected", () => {
    const visibleRowIds = ["folder-row"];
    const hiddenDescendantIds = ["child-row"];

    expect(
      getSelectAllState({
        selectableRowIds: visibleRowIds,
        rowSelection: getNextSelectAllRowSelection({
          selectableRowIds: visibleRowIds,
          rowSelection: {},
        }),
      }),
    ).toEqual({
      checked: true,
      indeterminate: false,
      key: "all",
    });

    expect(
      getSelectAllState({
        selectableRowIds: [...visibleRowIds, ...hiddenDescendantIds],
        rowSelection: { "folder-row": true },
      }),
    ).toEqual({
      checked: false,
      indeterminate: true,
      key: "some",
    });
  });
});
