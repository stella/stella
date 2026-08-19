import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_CONTENT_MIN_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  INSPECTOR_RAIL_WIDTH,
  resolveInspectorDockWidth,
  resolveInspectorPaneWidth,
  shouldForceSidebarCollapsed,
} from "./pane-width";

const EXPANDED_SIDEBAR_WIDTH = 256;
const COLLAPSED_SIDEBAR_WIDTH = 48;

describe("resolveInspectorPaneWidth", () => {
  // The regression this guards: the pane kept its dragged width while the
  // viewport shrank, so the content column got whatever pixels were left.
  test("never starves the content column across desktop widths", () => {
    for (let viewportWidth = 768; viewportWidth <= 2560; viewportWidth += 1) {
      const sidebarWidth = shouldForceSidebarCollapsed({
        expandedSidebarWidth: EXPANDED_SIDEBAR_WIDTH,
        inspectorPaneOpen: true,
        viewportWidth,
      })
        ? COLLAPSED_SIDEBAR_WIDTH
        : EXPANDED_SIDEBAR_WIDTH;
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
        sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
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
        sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
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
      sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
    });
    const collapsed = resolveInspectorPaneWidth({
      ...args,
      sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
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

describe("shouldForceSidebarCollapsed", () => {
  test("collapses only while an open pane needs the expanded sidebar's space", () => {
    expect(
      shouldForceSidebarCollapsed({
        expandedSidebarWidth: EXPANDED_SIDEBAR_WIDTH,
        inspectorPaneOpen: true,
        viewportWidth:
          EXPANDED_SIDEBAR_WIDTH +
          INSPECTOR_CONTENT_MIN_WIDTH +
          INSPECTOR_PANE_MIN_WIDTH -
          1,
      }),
    ).toBe(true);
    expect(
      shouldForceSidebarCollapsed({
        expandedSidebarWidth: EXPANDED_SIDEBAR_WIDTH,
        inspectorPaneOpen: true,
        viewportWidth:
          EXPANDED_SIDEBAR_WIDTH +
          INSPECTOR_CONTENT_MIN_WIDTH +
          INSPECTOR_PANE_MIN_WIDTH,
      }),
    ).toBe(false);
    expect(
      shouldForceSidebarCollapsed({
        expandedSidebarWidth: EXPANDED_SIDEBAR_WIDTH,
        inspectorPaneOpen: false,
        viewportWidth: 768,
      }),
    ).toBe(false);
  });
});

describe("resolveInspectorDockWidth", () => {
  test("reserves the rail while the pane is collapsed", () => {
    expect(
      resolveInspectorDockWidth({ paneWidth: 512, showPaneContent: false }),
    ).toBe(INSPECTOR_RAIL_WIDTH);
  });

  test("reserves the full pane while content is shown", () => {
    expect(
      resolveInspectorDockWidth({ paneWidth: 512, showPaneContent: true }),
    ).toBe(512);
  });
});
