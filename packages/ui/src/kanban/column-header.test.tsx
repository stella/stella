import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanColumnHeader } from "./column-header";
import { KANBAN_CHROME_ROW_HEIGHT } from "./layout-tokens";

// Static markup carries no layout; this test pins the classes that keep the
// column top on the shared chrome row height and stop a long title from
// growing it.

describe("KanbanColumnHeader", () => {
  test("carries the chrome row height and truncates the title", () => {
    const markup = renderToStaticMarkup(
      <KanbanColumnHeader title="A very long column name" />,
    );
    const rootClass = /class="([^"]*)"/u.exec(markup)?.[1] ?? "";

    expect(rootClass.split(" ")).toEqual(
      expect.arrayContaining([
        KANBAN_CHROME_ROW_HEIGHT,
        "items-center",
        "px-3",
      ]),
    );
    expect(rootClass).not.toContain("py-2");
    expect(markup).toContain("truncate");
  });

  test("pins the name to the visible edge without covering the row's end", () => {
    const markup = renderToStaticMarkup(
      <KanbanColumnHeader
        actions={<button type="button">menu</button>}
        meta="7"
        swatch={<span>dot</span>}
        title="A very long column name"
      />,
    );
    const titleGroup =
      /<div[^>]*data-kanban-column-title=""[^>]*>/u.exec(markup)?.[0] ?? "";

    // The swatch, the name and the count travel together, sized to their own
    // content so they have room to travel at all.
    expect(titleGroup).toContain("sticky");
    expect(titleGroup).toContain("start-0");
    expect(titleGroup).toContain("w-fit");
    expect(titleGroup).toContain("max-w-full");
    expect(titleGroup).toContain("z-10");
    // Whatever surface the header row carries, rather than one of its own: a
    // caller washes the header cell in the column's accent, and the name has
    // to let that paint through.
    expect(titleGroup).toContain("bg-inherit");
    expect(titleGroup).not.toContain("bg-background");
    // It travels inside a box that ends where the row's own controls begin,
    // so a pinned name can never slide over the calculation or the menu.
    const travelRegion =
      /<div class="(?<classes>[^"]*)"><div[^>]*data-kanban-column-title=""/u
        .exec(markup)
        ?.groups?.["classes"]?.split(" ");

    expect(travelRegion).toEqual(
      expect.arrayContaining(["flex", "min-w-0", "flex-1"]),
    );
    expect(markup.indexOf("data-kanban-column-title")).toBeLessThan(
      markup.indexOf("menu"),
    );
  });
});
