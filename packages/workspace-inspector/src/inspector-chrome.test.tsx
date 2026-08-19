import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Inspector,
  InspectorEmptyRow,
  InspectorHeader,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyValue,
  InspectorRail,
  InspectorRailCell,
  InspectorRailTab,
  InspectorSectionTitle,
} from "./inspector-chrome";
import { InspectorDock } from "./inspector-dock";
import { TOOLBAR_ROW_HEIGHT } from "./layout-tokens";

const classesOf = (markup: string, slot: string): string[] => {
  const match = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "u").exec(markup);
  if (match === null) {
    throw new Error(`no element with data-slot="${slot}" in ${markup}`);
  }
  const classAttr = /class="([^"]*)"/u.exec(match[0]);
  return classAttr?.[1]?.split(/\s+/u) ?? [];
};

const noopHandlers = {
  "aria-orientation": "vertical",
  "aria-valuemax": 800,
  "aria-valuemin": 320,
  "aria-valuenow": 512,
  onKeyDown: () => undefined,
  onPointerDown: () => undefined,
  onPointerMove: () => undefined,
  onPointerUp: () => undefined,
  tabIndex: 0,
} as const;

describe("row rhythm", () => {
  // The regression this guards: a row given a *minimum* height grows with
  // its content, so a column of key/value rows stops scanning as a list and
  // stops lining up with the rail's 48px cells.
  test.each([
    ["inspector-property", <InspectorProperty key="p" />],
    ["inspector-section-title", <InspectorSectionTitle key="s" />],
    ["inspector-empty-row", <InspectorEmptyRow key="e" />],
    ["inspector-header", <InspectorHeader key="h" />],
    ["inspector-rail-cell", <InspectorRailCell key="c" />],
    ["inspector-rail-tab", <InspectorRailTab key="t" />],
  ])("%s is exactly one row tall", (slot, element) => {
    const classes = classesOf(renderToStaticMarkup(element), slot);
    expect(classes).toContain(TOOLBAR_ROW_HEIGHT);
    expect(classes.some((c) => c.startsWith("min-h-1"))).toBe(false);
    expect(classes.some((c) => c.startsWith("py-"))).toBe(false);
  });

  test("the property row keeps its two-column grid and truncates", () => {
    const markup = renderToStaticMarkup(
      <InspectorProperty>
        <InspectorPropertyLabel>label</InspectorPropertyLabel>
        <InspectorPropertyValue>value</InspectorPropertyValue>
      </InspectorProperty>,
    );
    expect(classesOf(markup, "inspector-property")).toEqual(
      expect.arrayContaining([
        "grid",
        "grid-cols-[8rem_minmax(0,1fr)]",
        "h-12",
      ]),
    );
    // A row of fixed height must clip, not overflow, an over-long value.
    expect(classesOf(markup, "inspector-property-label")).toContain("truncate");
    expect(classesOf(markup, "inspector-property-value")).toContain("truncate");
  });
});

describe("rail", () => {
  test("occupies exactly the reserved 48px and is desktop-only", () => {
    const classes = classesOf(
      renderToStaticMarkup(<InspectorRail />),
      "inspector-rail",
    );
    // Both inline borders live on the rail box, so border-box keeps the
    // footprint at w-12 regardless of the borders.
    expect(classes).toEqual(
      expect.arrayContaining([
        "w-12",
        "border-s",
        "border-e",
        "hidden",
        "md:flex",
      ]),
    );
  });
});

describe("dock", () => {
  const renderDock = (showPaneContent: boolean) =>
    renderToStaticMarkup(
      <InspectorDock
        resizeHandleLabel="Resize"
        resizeHandleProps={noopHandlers}
        showPaneContent={showPaneContent}
        width={512}
      >
        <Inspector />
      </InspectorDock>,
    );

  // The regression this guards: a fixed pane with no in-flow sibling covers
  // the content column instead of making it reflow.
  test("backs the fixed pane with a same-width in-flow spacer", () => {
    const markup = renderDock(true);
    expect(classesOf(markup, "inspector-dock-pane")).toEqual(
      expect.arrayContaining(["fixed", "inset-y-0", "end-0"]),
    );
    expect(markup.match(/width:512px/gu)?.length).toBe(2);
    expect(classesOf(markup, "inspector-dock-spacer")).toContain("relative");
  });

  test("exposes a col-resize handle only while the pane is expanded", () => {
    expect(renderDock(true)).toContain('data-slot="inspector-resize-handle"');
    expect(renderDock(false)).not.toContain(
      'data-slot="inspector-resize-handle"',
    );
  });

  test("reports its expanded/collapsed state on the dock element", () => {
    expect(renderDock(true)).toContain('data-state="expanded"');
    expect(renderDock(false)).toContain('data-state="collapsed"');
  });

  // A drag handle nobody can reach by keyboard is a resize nobody can
  // perform without a pointer; the original app-local handle was a bare div.
  test("exposes the handle as a focusable separator carrying its range", () => {
    const markup = renderDock(true);
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-valuenow="512"');
    expect(markup).toContain('aria-valuemin="320"');
    expect(markup).toContain('aria-valuemax="800"');
  });

  test("is desktop-only; the pane becomes a sheet below the breakpoint", () => {
    expect(classesOf(renderDock(true), "inspector-dock")).toEqual(
      expect.arrayContaining(["hidden", "md:block"]),
    );
  });
});
