import { describe, expect, test } from "bun:test";

import {
  createColumnOrderState,
  createColumnPinningState,
  createColumnVisibilityState,
  getPersistedColumnOrder,
  getPersistedColumnPinning,
  getPersistedHiddenColumnIds,
  omitUtilityColumnSizing,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state.logic";

describe("workspace table state normalization", () => {
  test("keeps utility columns in live pinning state only", () => {
    const liveState = createColumnPinningState([
      "status",
      "add-property",
      "owner",
    ]);

    expect(liveState).toEqual({
      left: ["select", "status", "owner"],
      right: [],
    });
    expect(getPersistedColumnPinning(liveState)).toEqual(["status", "owner"]);
  });

  test("keeps utility columns in live order state only", () => {
    const liveState = createColumnOrderState(["name", "select", "status"]);

    expect(liveState).toEqual(["select", "name", "status"]);
    expect(getPersistedColumnOrder(liveState)).toEqual(["name", "status"]);
  });

  test("does not persist hidden utility columns", () => {
    const liveState = createColumnVisibilityState([
      "select",
      "status",
      "add-property",
    ]);

    expect(liveState).toEqual({ status: false });
    expect(
      getPersistedHiddenColumnIds({
        ...liveState,
        owner: true,
        priority: false,
      }),
    ).toEqual(["status", "priority"]);
  });

  test("does not persist utility column sizing", () => {
    expect(
      omitUtilityColumnSizing({
        "add-property": 48,
        select: 48,
        status: 180,
      }),
    ).toEqual({ status: 180 });
  });
});
