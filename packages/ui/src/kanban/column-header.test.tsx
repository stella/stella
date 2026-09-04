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
});
