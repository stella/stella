import { describe, expect, test } from "bun:test";

import { DIRECTLY_CREATABLE_VIEW_LAYOUTS } from "@stll/api-contract";

import { unavailableViewLayouts } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-options.logic";

const addMenu = (
  avtEnabled: boolean,
  held: readonly ("overview" | "correspondence")[] = [],
) => {
  const unavailable = unavailableViewLayouts({
    heldSingleLayouts: new Set(held),
    avtEnabled,
  });
  return DIRECTLY_CREATABLE_VIEW_LAYOUTS.filter(
    (layout) => !unavailable.has(layout),
  );
};

describe("add-view menu layouts", () => {
  test("offers AVT only with the verification feature", () => {
    expect(addMenu(true)).toContain("avt");
    expect(addMenu(false)).not.toContain("avt");
  });

  test("never offers a second copy of a layout held once", () => {
    expect(addMenu(true, ["correspondence"])).not.toContain("correspondence");
    expect(addMenu(true)).toContain("correspondence");
  });
});
