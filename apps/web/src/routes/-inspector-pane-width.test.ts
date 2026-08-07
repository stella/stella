import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_CONTENT_MIN_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  resolveInspectorPaneWidth,
} from "@/routes/-inspector-pane-width";

const SIDEBAR_EXPANDED = 256;
const SIDEBAR_COLLAPSED = 48;

describe("resolveInspectorPaneWidth", () => {
  // The regression this guards: the pane kept its dragged width while the
  // viewport shrank, so the content column got whatever pixels were left.
  test("never starves the content column while the pane can still shrink", () => {
    for (let viewportWidth = 768; viewportWidth <= 2560; viewportWidth += 1) {
      for (const sidebarWidth of [SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED]) {
        const width = resolveInspectorPaneWidth({
          desiredWidth: INSPECTOR_PANE_MAX_WIDTH,
          sidebarWidth,
          viewportWidth,
        });
        const content = viewportWidth - sidebarWidth - width;
        expect(
          content >= INSPECTOR_CONTENT_MIN_WIDTH ||
            width === INSPECTOR_PANE_MIN_WIDTH,
        ).toBe(true);
      }
    }
  });

  test("stays within the pane's own bounds for any dragged width", () => {
    for (const desiredWidth of [-500, 0, 120, 512, 5000]) {
      const width = resolveInspectorPaneWidth({
        desiredWidth,
        sidebarWidth: SIDEBAR_COLLAPSED,
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
        sidebarWidth: SIDEBAR_EXPANDED,
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
      sidebarWidth: SIDEBAR_EXPANDED,
    });
    const collapsed = resolveInspectorPaneWidth({
      ...args,
      sidebarWidth: SIDEBAR_COLLAPSED,
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
});
