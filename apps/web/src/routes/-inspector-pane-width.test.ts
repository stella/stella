import { describe, expect, test } from "bun:test";

import {
  SIDEBAR_WIDTH_ICON_PX,
  SIDEBAR_WIDTH_PX,
} from "@/components/sidebar-sizing";
import {
  INSPECTOR_CONTENT_MIN_WIDTH,
  INSPECTOR_EDITOR_MIN_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  resolveInspectorPaneMaxWidth,
  resolveInspectorPaneWidth,
  shouldForceSidebarCollapsed,
} from "@/routes/-inspector-pane-width";

describe("resolveInspectorPaneWidth", () => {
  // The regression this guards: the pane kept its dragged width while the
  // viewport shrank, so the content column got whatever pixels were left.
  test("never starves the content column across desktop widths", () => {
    for (let viewportWidth = 768; viewportWidth <= 2560; viewportWidth += 1) {
      const sidebarWidth = shouldForceSidebarCollapsed({
        inspectorPaneOpen: true,
        viewportWidth,
      })
        ? SIDEBAR_WIDTH_ICON_PX
        : SIDEBAR_WIDTH_PX;
      const width = resolveInspectorPaneWidth({
        desiredWidth: INSPECTOR_PANE_MAX_WIDTH,
        sidebarWidth,
        viewportWidth,
      });
      const content = viewportWidth - sidebarWidth - width;
      expect(content).toBeGreaterThanOrEqual(INSPECTOR_CONTENT_MIN_WIDTH);
    }
  });

  test("stays within the pane's own bounds for any dragged width", () => {
    for (const desiredWidth of [-500, 0, 120, 512, 5000]) {
      const width = resolveInspectorPaneWidth({
        desiredWidth,
        sidebarWidth: SIDEBAR_WIDTH_ICON_PX,
        viewportWidth: 2560,
      });
      expect(width).toBeGreaterThanOrEqual(INSPECTOR_PANE_MIN_WIDTH);
      expect(width).toBeLessThanOrEqual(INSPECTOR_PANE_MAX_WIDTH);
    }
  });

  test("honours the dragged width when there is room for it", () => {
    expect(
      resolveInspectorPaneWidth({
        desiredWidth: 640,
        sidebarWidth: SIDEBAR_WIDTH_PX,
        viewportWidth: 1920,
      }),
    ).toBe(640);
  });

  test("collapsing the sidebar gives the reclaimed space back to the pane", () => {
    const args = {
      desiredWidth: INSPECTOR_PANE_MAX_WIDTH,
      viewportWidth: 1440,
    };
    const expanded = resolveInspectorPaneWidth({
      ...args,
      sidebarWidth: SIDEBAR_WIDTH_PX,
    });
    const collapsed = resolveInspectorPaneWidth({
      ...args,
      sidebarWidth: SIDEBAR_WIDTH_ICON_PX,
    });
    expect(collapsed).toBeGreaterThan(expanded);
  });

  test("falls back to the minimum before the viewport is known", () => {
    expect(
      resolveInspectorPaneWidth({
        desiredWidth: INSPECTOR_PANE_MAX_WIDTH,
        sidebarWidth: 0,
        viewportWidth: 0,
      }),
    ).toBe(INSPECTOR_PANE_MIN_WIDTH);
  });

  // The reviewer's complaint: the pane would not drag any further towards the
  // middle. On a wide screen it now can, and the editor keeps a readable
  // column beside it.
  test("drags past the old fixed cap on a wide viewport", () => {
    const width = resolveInspectorPaneWidth({
      desiredWidth: INSPECTOR_PANE_MAX_WIDTH,
      sidebarWidth: SIDEBAR_WIDTH_ICON_PX,
      viewportWidth: 2560,
    });
    expect(width).toBeGreaterThan(800);
    expect(2560 - width).toBeGreaterThanOrEqual(INSPECTOR_EDITOR_MIN_WIDTH);
    expect(width).toBe(
      resolveInspectorPaneMaxWidth({
        sidebarWidth: SIDEBAR_WIDTH_ICON_PX,
        viewportWidth: 2560,
      }),
    );
  });
});

describe("shouldForceSidebarCollapsed", () => {
  test("collapses only while an open pane needs the expanded sidebar's space", () => {
    expect(
      shouldForceSidebarCollapsed({
        inspectorPaneOpen: true,
        viewportWidth:
          SIDEBAR_WIDTH_PX +
          INSPECTOR_CONTENT_MIN_WIDTH +
          INSPECTOR_PANE_MIN_WIDTH -
          1,
      }),
    ).toBe(true);
    expect(
      shouldForceSidebarCollapsed({
        inspectorPaneOpen: true,
        viewportWidth:
          SIDEBAR_WIDTH_PX +
          INSPECTOR_CONTENT_MIN_WIDTH +
          INSPECTOR_PANE_MIN_WIDTH,
      }),
    ).toBe(false);
    expect(
      shouldForceSidebarCollapsed({
        inspectorPaneOpen: false,
        viewportWidth: 768,
      }),
    ).toBe(false);
  });
});
