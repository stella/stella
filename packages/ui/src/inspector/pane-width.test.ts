import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_CONTENT_MIN_WIDTH,
  INSPECTOR_EDITOR_MIN_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  INSPECTOR_RAIL_WIDTH,
  resolveInspectorDockWidth,
  resolveInspectorPaneMaxWidth,
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

describe("resolveInspectorPaneMaxWidth", () => {
  // The complaint this answers: the pane stopped at a fixed 800px however
  // much room the viewport had, so a wide screen could not give the two
  // compared passages more than half the space they needed.
  test("gives a wide viewport more than the old fixed 800px cap", () => {
    expect(
      resolveInspectorPaneMaxWidth({
        sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
        viewportWidth: 2560,
      }),
    ).toBeGreaterThan(800);
  });

  test("never exceeds the absolute ceiling, however wide the viewport", () => {
    expect(
      resolveInspectorPaneMaxWidth({
        sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
        viewportWidth: 7680,
      }),
    ).toBe(INSPECTOR_PANE_MAX_WIDTH);
  });

  test("leaves the editor its readable measure wherever the pane is not at its own minimum", () => {
    for (let viewportWidth = 768; viewportWidth <= 3840; viewportWidth += 1) {
      for (const sidebarWidth of [
        COLLAPSED_SIDEBAR_WIDTH,
        EXPANDED_SIDEBAR_WIDTH,
      ]) {
        const max = resolveInspectorPaneMaxWidth({
          sidebarWidth,
          viewportWidth,
        });
        if (max === INSPECTOR_PANE_MIN_WIDTH) {
          continue;
        }
        expect(viewportWidth - max).toBeGreaterThanOrEqual(
          INSPECTOR_EDITOR_MIN_WIDTH,
        );
      }
    }
  });

  // A viewport-relative ceiling that dipped as the window grew would make the
  // pane snap narrower mid-resize.
  test("never shrinks as the viewport grows", () => {
    let previous = 0;
    for (let viewportWidth = 768; viewportWidth <= 3840; viewportWidth += 1) {
      const max = resolveInspectorPaneMaxWidth({
        sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
        viewportWidth,
      });
      expect(max).toBeGreaterThanOrEqual(previous);
      previous = max;
    }
  });

  test("falls back to the minimum before the viewport is known", () => {
    expect(
      resolveInspectorPaneMaxWidth({ sidebarWidth: 0, viewportWidth: 0 }),
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
