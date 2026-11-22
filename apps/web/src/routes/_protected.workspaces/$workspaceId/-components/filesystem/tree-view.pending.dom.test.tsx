import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const testing = await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { toSafeId } = await import("@/lib/safe-id");
const columns =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view-columns.logic");
const {
  FilesystemViewPending,
  FILESYSTEM_BREADCRUMB_ROW_CLASS,
  FILESYSTEM_COLUMN_HEADER_CLASS,
  FILESYSTEM_CONTENT_CLASS,
  FILESYSTEM_EXTRA_CELL_CLASS,
  FILESYSTEM_FOOTER_CLASS,
  FILESYSTEM_ROWS_CLASS,
  FILESYSTEM_ROW_GRID_CLASS,
  FILESYSTEM_SCROLL_CLASS,
  FILESYSTEM_VIEW_CLASS,
} =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view.pending");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000aa";

const base = (id: string) => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
  status: "fresh" as const,
  kinds: null,
  tool: { version: 1 as const, type: "manual-input" as const },
});

const properties: WorkspaceProperty[] = [
  { ...base("notes"), content: { version: 1, type: "text" } },
  { ...base("hidden"), content: { version: 1, type: "text" } },
  { ...base("documents"), content: { version: 1, type: "file" } },
];

const view: WorkspaceView<"filesystem"> = {
  version: 1,
  id: "view-files",
  name: "Files",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "filesystem",
    filters: [],
    sorts: [],
    hiddenProperties: [
      toSafeId<"property">("hidden"),
      columns.FILESYSTEM_VERSION_ID,
    ],
    calculations: [],
  },
};

const renderAt = async (pathname: string, Page: RouteComponent) => {
  const rootRoute = router.createRootRoute({ component: router.Outlet });
  const viewRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$workspaceId/$viewId",
    component: Page,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: [pathname] }),
    isServer: false,
    routeTree: rootRoute.addChildren([viewRoute]),
  });
  await appRouter.load();
  return testing.render(<router.RouterProvider router={appRouter} />).container;
};

const Face = () => (
  <FilesystemViewPending
    properties={properties}
    view={view}
    workspaceId={WORKSPACE_ID}
  />
);

const byClass = (container: HTMLElement, className: string) => {
  const found = container.querySelector<HTMLElement>(
    className
      .split(" ")
      .map((token) => `.${CSS.escape(token)}`)
      .join(""),
  );
  if (found === null) {
    throw new Error(`nothing drawn with ${className}`);
  }
  return found;
};

const FOCUSABLE =
  "button, a[href], input, select, textarea, [tabindex], [contenteditable]";

describe("a filesystem view before its entities load", () => {
  test("draws the tree's box, header and rows in the tree's own grid", async () => {
    const container = await renderAt(
      `/workspaces/${WORKSPACE_ID}/view-files`,
      Face,
    );
    const root = byClass(container, FILESYSTEM_VIEW_CLASS);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    byClass(root, FILESYSTEM_BREADCRUMB_ROW_CLASS);
    const scroller = byClass(root, FILESYSTEM_SCROLL_CLASS);
    byClass(scroller, FILESYSTEM_CONTENT_CLASS);
    byClass(root, FILESYSTEM_FOOTER_CLASS);

    const extra = columns.resolveExtraColumns(
      view.layout.hiddenProperties,
      properties,
      {},
    );
    // Author and last updated, then the shown property: no hidden column,
    // no file column, no version column (hidden).
    expect(extra.map((column) => column.id)).toEqual([
      columns.FILESYSTEM_CREATED_BY_ID,
      columns.FILESYSTEM_UPDATED_AT_ID,
      toSafeId<"property">("notes"),
    ]);
    const template = columns.buildGridTemplate(extra, {});

    const header = byClass(scroller, FILESYSTEM_COLUMN_HEADER_CLASS);
    expect(header.style.gridTemplateColumns).toBe(template);
    // Name, the extra columns, the actions track.
    expect(header.children.length).toBe(1 + extra.length + 1);
    expect(header.textContent).toContain("notes");

    const rowsBox = byClass(scroller, FILESYSTEM_ROWS_CLASS);
    const rows = [...rowsBox.children].filter(
      (row): row is HTMLElement => row instanceof HTMLElement,
    );
    expect(rows.length).toBe(12);
    for (const row of rows) {
      expect(row.style.height).toBe(
        `${String(columns.FILESYSTEM_ROW_HEIGHT_PX)}px`,
      );
      const grid = byClass(row, FILESYSTEM_ROW_GRID_CLASS);
      expect(grid.style.gridTemplateColumns).toBe(template);
      expect(
        row.querySelectorAll(
          `.${CSS.escape(FILESYSTEM_EXTRA_CELL_CLASS.split(" ")[0] ?? "")}`,
        ).length,
      ).toBe(extra.length);
    }

    expect(root.querySelectorAll(FOCUSABLE).length).toBe(0);
  });

  test("stands stored column widths in the template", async () => {
    // A column nobody sized yields from its default width to the minimum.
    const YIELDING_TRACK = `minmax(${String(columns.MIN_COLUMN_WIDTH_PX)}px, ${String(columns.DEFAULT_EXTRA_WIDTH_PX)}px)`;
    const container = await renderAt(
      `/workspaces/${WORKSPACE_ID}/view-files`,
      () => (
        <FilesystemViewPending
          columnWidths={{ [columns.NAME_COL_ID]: 300, notes: 200 }}
          properties={properties}
          view={view}
          workspaceId={WORKSPACE_ID}
        />
      ),
    );
    const header = byClass(container, FILESYSTEM_COLUMN_HEADER_CLASS);
    expect(header.style.gridTemplateColumns).toBe(
      `300px ${YIELDING_TRACK} ${YIELDING_TRACK} 200px 2rem`,
    );
  });

  test("keeps the breadcrumb line only inside a folder", async () => {
    const atRoot = await renderAt(
      `/workspaces/${WORKSPACE_ID}/view-files`,
      Face,
    );
    expect(byClass(atRoot, FILESYSTEM_BREADCRUMB_ROW_CLASS).textContent).toBe(
      "",
    );
    expect(
      byClass(atRoot, FILESYSTEM_BREADCRUMB_ROW_CLASS).querySelectorAll(
        '[data-slot="face-label-skeleton"]',
      ).length,
    ).toBe(0);
    testing.cleanup();

    const inFolder = await renderAt(
      `/workspaces/${WORKSPACE_ID}/view-files?folder=folder-1`,
      Face,
    );
    expect(
      byClass(inFolder, FILESYSTEM_BREADCRUMB_ROW_CLASS).querySelectorAll(
        '[data-slot="face-label-skeleton"]',
      ).length,
    ).toBe(1);
  });
});
