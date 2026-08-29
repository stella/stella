import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type * as ChromeModule from "./chrome";
import {
  Inspector,
  InspectorActions,
  InspectorContent,
  InspectorDescription,
  InspectorEmptyRow,
  InspectorHeader,
  InspectorHeaderText,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorRail,
  InspectorRailCell,
  InspectorRailContent,
  InspectorRailFooter,
  InspectorRailIconButton,
  InspectorRailTab,
  InspectorSection,
  InspectorSectionTitle,
  InspectorTitle,
} from "./chrome";
import { InspectorDock } from "./dock";
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
  onLostPointerCapture: () => undefined,
  onPointerCancel: () => undefined,
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
  test("a tab fills the rail width and boxes itself like a rail cell", () => {
    const classes = classesOf(
      renderToStaticMarkup(<InspectorRailTab active />),
      "inspector-rail-tab",
    );

    expect(classes).toEqual(
      expect.arrayContaining(["w-full", "border-b", "before:bg-primary"]),
    );
  });

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

  test("rail actions retain an iPad-safe touch target and keyboard focus", () => {
    const classes = classesOf(
      renderToStaticMarkup(<InspectorRailIconButton />),
      "inspector-rail-icon-button",
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        "size-11",
        "focus-visible:ring-2",
        "disabled:pointer-events-none",
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

  // The regression this guards: the root was a bare block with the width on
  // the spacer alone, so a plain block host stretched it to the full
  // containing width and the content column it exists to preserve was pushed
  // off-screen.
  test("reserves its own inline size on the root, not only on the spacer", () => {
    const markup = renderDock(true);
    const root = /<[^>]*data-slot="inspector-dock"[^>]*>/u.exec(markup)?.[0];

    expect(root).toContain("width:512px");
    expect(classesOf(markup, "inspector-dock")).toContain("shrink-0");
    expect(classesOf(markup, "inspector-dock-spacer")).toContain("w-full");
  });

  test("is desktop-only; the pane becomes a sheet below the breakpoint", () => {
    expect(classesOf(renderDock(true), "inspector-dock")).toEqual(
      expect.arrayContaining(["hidden", "md:block"]),
    );
  });
});

// Total over the module's exports, so a new slot component cannot land
// without being named here: `satisfies` fails to compile until it is, and the
// coverage assertion below then fails until the fixture renders it and
// RECORD_DATA_SLOTS classifies it as record data or chrome.
const SLOT_BY_EXPORT = {
  Inspector: "inspector",
  InspectorActions: "inspector-actions",
  InspectorContent: "inspector-content",
  InspectorDescription: "inspector-description",
  InspectorEmptyRow: "inspector-empty-row",
  InspectorHeader: "inspector-header",
  InspectorHeaderText: "inspector-header-text",
  InspectorProperty: "inspector-property",
  InspectorPropertyLabel: "inspector-property-label",
  InspectorPropertyList: "inspector-property-list",
  InspectorPropertyValue: "inspector-property-value",
  InspectorRail: "inspector-rail",
  InspectorRailCell: "inspector-rail-cell",
  InspectorRailContent: "inspector-rail-content",
  InspectorRailFooter: "inspector-rail-footer",
  InspectorRailIconButton: "inspector-rail-icon-button",
  InspectorRailTab: "inspector-rail-tab",
  InspectorSection: "inspector-section",
  InspectorSectionTitle: "inspector-section-title",
  InspectorTitle: "inspector-title",
} as const satisfies Record<keyof typeof ChromeModule, string>;

type InspectorSlot = (typeof SLOT_BY_EXPORT)[keyof typeof SLOT_BY_EXPORT];

// Slots carrying caller-supplied record values; each must isolate its own bidi
// context so a Latin value inside an RTL inspector keeps its character order.
const RECORD_DATA_SLOTS = [
  "inspector-description",
  "inspector-property-value",
  "inspector-title",
] as const satisfies readonly InspectorSlot[];

describe("bidi", () => {
  test("isolates exactly the record-data slots", () => {
    // Every exported slot is rendered, so the assertion below is a closed set
    // over the whole shell rather than over whichever slots a case happened to
    // use: a new record-data slot that forgets `dir` fails the first
    // direction, and a chrome slot that grows one fails the second.
    const markup = renderToStaticMarkup(
      <Inspector>
        <InspectorRail>
          <InspectorRailCell>
            <InspectorRailIconButton />
          </InspectorRailCell>
          <InspectorRailContent>
            <InspectorRailTab active>Overview</InspectorRailTab>
          </InspectorRailContent>
          <InspectorRailFooter />
        </InspectorRail>
        <InspectorHeader>
          <InspectorHeaderText>
            {/* A Latin identifier is exactly the value an RTL inspector reorders. */}
            <InspectorTitle>ECLI:CZ:NS:2024:25.CDO.1234.2023.1</InspectorTitle>
            <InspectorDescription>8 Tdo 1234/2023</InspectorDescription>
          </InspectorHeaderText>
          <InspectorActions>Actions</InspectorActions>
        </InspectorHeader>
        <InspectorContent>
          <InspectorSection>
            <InspectorSectionTitle>Metadata</InspectorSectionTitle>
            <InspectorPropertyList>
              <InspectorProperty>
                <InspectorPropertyLabel>Docket</InspectorPropertyLabel>
                <InspectorPropertyValue>
                  25 Cdo 1234/2023
                </InspectorPropertyValue>
              </InspectorProperty>
            </InspectorPropertyList>
            <InspectorEmptyRow>Nothing here</InspectorEmptyRow>
          </InspectorSection>
        </InspectorContent>
      </Inspector>,
    );

    const renderedSlots = new Set<string>();
    const isolatedSlots = new Set<string>();

    for (const tag of markup.match(/<[a-z][^>]*>/gu) ?? []) {
      const slot = /data-slot="([^"]+)"/u.exec(tag)?.[1];

      if (slot === undefined) {
        continue;
      }

      renderedSlots.add(slot);

      if (
        tag.includes('dir="auto"') &&
        tag.includes("[unicode-bidi:isolate]")
      ) {
        isolatedSlots.add(slot);
      }
    }

    expect([...renderedSlots].sort()).toEqual(
      Object.values(SLOT_BY_EXPORT).toSorted(),
    );
    expect([...isolatedSlots].sort()).toEqual([...RECORD_DATA_SLOTS]);
  });

  test("lets callers force a direction on a record-data slot", () => {
    const markup = renderToStaticMarkup(
      <InspectorPropertyValue dir="ltr">CASE-1/2023</InspectorPropertyValue>,
    );

    expect(markup).toContain('dir="ltr"');
    expect(markup).not.toContain('dir="auto"');
  });
});
