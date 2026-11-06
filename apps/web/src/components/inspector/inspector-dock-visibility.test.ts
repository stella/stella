import { describe, expect, test } from "bun:test";

import { resolveInspectorDockVisibility } from "@/components/inspector/inspector-dock-visibility";

describe("inspector dock visibility", () => {
  test("the dock reserves the saved pane before any tab restores", () => {
    expect(
      resolveInspectorDockVisibility({
        reservePane: true,
        tabCount: 0,
        minimized: false,
      }),
    ).toEqual({ dockOpen: true, sheetOpen: false });
  });

  test("the mobile sheet opens only on an open tab", () => {
    for (const reservePane of [false, true]) {
      expect(
        resolveInspectorDockVisibility({
          reservePane,
          tabCount: 2,
          minimized: false,
        }),
      ).toEqual({ dockOpen: true, sheetOpen: true });
      expect(
        resolveInspectorDockVisibility({
          reservePane,
          tabCount: 2,
          minimized: true,
        }).sheetOpen,
      ).toBe(false);
    }
  });

  test("nothing opens without tabs or a reservation", () => {
    expect(
      resolveInspectorDockVisibility({
        reservePane: false,
        tabCount: 0,
        minimized: false,
      }),
    ).toEqual({ dockOpen: false, sheetOpen: false });
    expect(
      resolveInspectorDockVisibility({
        reservePane: false,
        tabCount: 3,
        minimized: true,
      }).dockOpen,
    ).toBe(false);
  });
});
