import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanCellAction } from "./cell-action";
import { KANBAN_CHROME_ROW_HEIGHT } from "./layout-tokens";

// Static markup carries no layout; these tests pin the structure and the
// utilities that give every cell the same ending row.

const readButton = (markup: string) => {
  const match = /<button[^>]*data-slot="kanban-cell-action"[^>]*>/u.exec(
    markup,
  );

  if (!match) {
    throw new Error("no cell action in the rendered markup");
  }

  return match[0];
};

describe("KanbanCellAction", () => {
  test("renders one full-width row outlined as the card it adds", () => {
    const markup = renderToStaticMarkup(
      <KanbanCellAction>New card</KanbanCellAction>,
    );
    const classes = /class="([^"]*)"/u.exec(readButton(markup))?.[1] ?? "";

    expect(classes.split(" ")).toEqual(
      expect.arrayContaining([
        KANBAN_CHROME_ROW_HEIGHT,
        "border-dashed",
        "w-full",
        "justify-start",
      ]),
    );
    // The button's own size drops a step at `sm`, which would take the row
    // off the board's chrome rhythm on every desktop width.
    expect(classes.split(" ")).toContain(`sm:${KANBAN_CHROME_ROW_HEIGHT}`);
    expect(markup.indexOf("<svg")).toBeLessThan(markup.indexOf("New card"));
  });

  test("forwards disabled and click wiring to the button", () => {
    const markup = renderToStaticMarkup(
      <KanbanCellAction disabled onClick={() => undefined}>
        New card
      </KanbanCellAction>,
    );

    expect(readButton(markup)).toContain("disabled");
  });
});
