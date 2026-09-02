import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanCellAction } from "./cell-action";

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
  test("renders one full-width ghost row on the card rhythm", () => {
    const markup = renderToStaticMarkup(
      <KanbanCellAction>New card</KanbanCellAction>,
    );
    const classes = /class="([^"]*)"/u.exec(readButton(markup))?.[1] ?? "";

    expect(classes.split(" ")).toEqual(
      expect.arrayContaining(["min-h-11", "w-full", "justify-start"]),
    );
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
