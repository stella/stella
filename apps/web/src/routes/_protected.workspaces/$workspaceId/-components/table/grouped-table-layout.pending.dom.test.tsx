import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const testing = await import("@testing-library/react");
const { ENTITY_KINDS } = await import("@stll/api-contract");
const { getInternalPropertyId } =
  await import("@/components/workspaces/internal-ids.logic");
const { PROPERTY_COLUMN_SIZE } =
  await import("@/components/workspaces/table/table-schema");
const { toSafeId } = await import("@/lib/safe-id");
const { getGroupSkeletonLayout } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout.logic");
const { GROUPED_TABLE_CLASS, GroupedTableViewPending } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout.pending");
const { pendingTableGrid } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/table/pending-table-columns.logic");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000aa";
const CLASSIFIER_ID = toSafeId<"property">("document-type");

const base = (id: string) => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
  status: "fresh" as const,
  kinds: null,
});

const textProperty = (id: string): WorkspaceProperty => ({
  ...base(id),
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "manual-input" },
});

const phase: WorkspaceProperty = {
  ...base("phase"),
  content: {
    version: 1,
    type: "single-select",
    options: [
      { value: "Draft", color: "gray" },
      { value: "Signed", color: "green" },
    ],
    fallback: null,
  },
  tool: { version: 1, type: "manual-input" },
};

const classifier: WorkspaceProperty = {
  ...base(CLASSIFIER_ID),
  name: "Document type",
  content: {
    version: 1,
    type: "single-select",
    options: [
      { value: "NDA", color: "blue" },
      { value: "SPA", color: "amber" },
    ],
    fallback: null,
  },
  tool: { version: 1, type: "ai-model", prompt: "", dependencies: [] },
};

// A playbook column scoped to the NDA section.
const ndaTerm: WorkspaceProperty = {
  ...base("nda-term"),
  content: { version: 1, type: "text" },
  tool: {
    version: 1,
    type: "manual-input",
    dependencies: [
      {
        dependsOnPropertyId: CLASSIFIER_ID,
        condition: {
          type: "compare",
          left: { type: "property", propertyId: CLASSIFIER_ID },
          op: "eq",
          right: { type: "literal", value: "NDA" },
        },
      },
    ],
  },
};

const groupedView = (groupByPropertyId: string): WorkspaceView<"table"> => ({
  version: 1,
  id: "view-grouped",
  name: "Grouped",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "table",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
    groupByPropertyId,
  },
});

const draw = (
  properties: readonly WorkspaceProperty[],
  view: WorkspaceView<"table">,
) =>
  testing.render(
    <GroupedTableViewPending
      properties={properties}
      view={view}
      workspaceId={WORKSPACE_ID}
    />,
  ).container;

const FOCUSABLE =
  "button, a[href], input, select, textarea, [tabindex], [contenteditable]";

/** Each section's grid box: the element carrying its column template. */
const sectionGrids = (container: HTMLElement) =>
  [...container.querySelectorAll("section")].map((section) => {
    const grid = section.querySelector<HTMLElement>(
      "[style*='--workspace-table-columns']",
    );
    if (grid === null) {
      throw new Error("a section without its grid");
    }
    return grid;
  });

describe("a grouped table before it mounts", () => {
  test("draws the grouped column, one section per option and uncategorized, in the table's grid", () => {
    const properties = [phase, textProperty("notes")];
    const view = groupedView(phase.id);
    const container = draw(properties, view);
    const root = container.firstElementChild;
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    for (const token of GROUPED_TABLE_CLASS.split(" ")) {
      expect(root?.classList.contains(token)).toBe(true);
    }

    const sections = container.querySelectorAll("section");
    expect(sections.length).toBe(3);
    expect(sections[0]?.textContent).toContain("Draft");
    expect(sections[1]?.textContent).toContain("Signed");

    const grid = pendingTableGrid({ properties, view });
    const { skeletonRowCount } = getGroupSkeletonLayout(undefined);
    for (const box of sectionGrids(container)) {
      expect(box.style.getPropertyValue("--workspace-table-columns")).toBe(
        grid.templateColumns,
      );
      expect(box.style.minWidth).toBe(`${String(grid.tableWidth)}px`);
      // The section's header row, then its placeholder rows.
      const rows = box.querySelectorAll('[data-slot="workspace-grid-row"]');
      expect(rows.length).toBe(1 + skeletonRowCount);
      expect(
        rows[0]?.querySelectorAll('[data-slot="workspace-grid-head"]').length,
      ).toBe(grid.renderColumns.length + 1);
    }
    expect(container.querySelectorAll(FOCUSABLE).length).toBe(0);
  });

  test("grouped by kind, draws a section per entity kind and uncategorized", () => {
    const container = draw(
      [textProperty("notes")],
      groupedView(getInternalPropertyId("kind")),
    );
    expect(container.querySelectorAll("section").length).toBe(
      ENTITY_KINDS.length + 1,
    );
    expect(container.querySelectorAll(FOCUSABLE).length).toBe(0);
  });

  test("grouped by the document-type classifier, a scoped column stands only in its section", () => {
    const properties = [classifier, ndaTerm];
    const container = draw(properties, groupedView(classifier.id));
    const [nda, spa, uncategorized] = sectionGrids(container);
    const widthOf = (box: HTMLElement | undefined) =>
      Number.parseFloat(box?.style.minWidth ?? "");
    expect(widthOf(nda) - widthOf(spa)).toBe(PROPERTY_COLUMN_SIZE);
    expect(widthOf(uncategorized)).toBe(widthOf(spa));
    const headsOf = (box: HTMLElement | undefined) =>
      box
        ?.querySelector('[data-slot="workspace-grid-row"]')
        ?.querySelectorAll('[data-slot="workspace-grid-head"]').length;
    expect((headsOf(nda) ?? 0) - (headsOf(spa) ?? 0)).toBe(1);
  });

  test("claims no shape where the grouping has no sections of its own", () => {
    const notes = textProperty("notes");
    expect(draw([notes], groupedView(notes.id)).childElementCount).toBe(0);
    expect(
      draw([notes], groupedView(getInternalPropertyId("status")))
        .childElementCount,
    ).toBe(0);
    expect(draw([notes], groupedView("")).childElementCount).toBe(0);
  });
});
