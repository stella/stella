import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/inspector";

import { WorkspaceViewSwitcher } from "./view-switcher";

const VIEWS = [
  { id: "table", name: "All matters", kind: "table" },
  { id: "calendar", name: "Deadlines", kind: "calendar" },
] as const;

describe("WorkspaceViewSwitcher", () => {
  test("renders generic view identity and host presentation slots", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceViewSwitcher
        activeViewId="table"
        addControl={<button type="button">Add view</button>}
        ariaLabel="Saved views"
        direction="ltr"
        onViewChange={() => undefined}
        reorder={null}
        renderActions={(view) =>
          view.id === "table" ? <button type="button">Actions</button> : null
        }
        renderIcon={(view) => <span>{view.kind}</span>}
        views={VIEWS}
      />,
    );

    expect(markup).toContain("Saved views");
    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain("All matters");
    expect(markup).toContain("Deadlines");
    expect(markup).toContain("Add view");
    expect(markup).toContain("Actions");
    // One toolbar row, the same height as the frame's top bar and a kanban
    // column header, so the three rows line up in any host.
    expect(markup).toContain(
      `class="flex min-w-0 flex-1 items-center gap-1 px-2 ${TOOLBAR_ROW_HEIGHT}"`,
    );
    expect(markup).toContain('class="h-full min-w-0 flex-1"');
    expect(markup).toContain("h-full gap-0");
    expect(markup).toContain('data-slot="tabs-list"');
    expect(markup.match(/pe-6\.5/gu)).toHaveLength(VIEWS.length);
    expect(markup).toContain('class="relative flex h-full items-center"');
    expect(markup).toContain(
      'class="absolute inset-e-0 top-1/2 -translate-y-1/2"',
    );
  });

  test("applies the drop direction to the rendered switcher", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceViewSwitcher
        activeViewId="table"
        ariaLabel="Saved views"
        direction="rtl"
        onViewChange={() => undefined}
        reorder={null}
        renderIcon={() => null}
        views={VIEWS}
      />,
    );

    expect(markup).toContain('dir="rtl"');
  });

  test("renders the editing branch without the normal label or actions", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceViewSwitcher
        activeViewId="table"
        ariaLabel="Saved views"
        direction="ltr"
        editing={{
          viewId: "table",
          renderLabel: () => <input aria-label="Rename view" />,
        }}
        onViewChange={() => undefined}
        reorder={null}
        renderActions={() => <button type="button">Actions</button>}
        renderIcon={() => null}
        views={VIEWS.slice(0, 1)}
      />,
    );

    expect(markup).toContain("Rename view");
    expect(markup).not.toContain("All matters");
    expect(markup).not.toContain("Actions");
    expect(markup).toContain("pe-6.5");
  });
});
