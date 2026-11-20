import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanColumnHeader } from "./column-header";
import { KanbanColumnHeaderShell } from "./column-header-shell";

const rowOf = (markup: string) =>
  /<div class="([^"]*)" data-kanban-column-header="">/u.exec(markup)?.[1];

describe("a kanban column header's loading row", () => {
  test("is the header's own row, so the header lands where it stood", () => {
    const header = renderToStaticMarkup(<KanbanColumnHeader title="Draft" />);
    const shell = renderToStaticMarkup(
      <KanbanColumnHeaderShell name="Draft" />,
    );
    expect(rowOf(shell)).toBeDefined();
    expect(rowOf(shell)).toBe(rowOf(header));
    expect(shell).toContain('data-kanban-column-title=""');
  });
});
