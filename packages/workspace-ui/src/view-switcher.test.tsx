import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

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
    expect(markup).toContain('class="relative flex items-center"');
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
  });
});
