import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanVirtualCell } from "./virtual-cell";
import type { KanbanVirtualCellProps } from "./virtual-cell";

// Static markup carries no layout; these tests pin the neutral surface's
// default output and the optional accent tint layered on top of it.

const readCell = (markup: string) => {
  const match = /<div[^>]*>/u.exec(markup);

  if (!match) {
    throw new Error("no cell surface in the rendered markup");
  }

  return match[0];
};

const renderCell = (overrides: Partial<KanbanVirtualCellProps<string>> = {}) =>
  readCell(
    renderToStaticMarkup(
      <KanbanVirtualCell
        getRowKey={(row) => row}
        pagination={{ type: "none" }}
        renderRow={(row) => <span>{row}</span>}
        rows={["one"]}
        {...overrides}
      />,
    ),
  );

describe("KanbanVirtualCell", () => {
  test("renders the plain neutral surface with no accent", () => {
    const cell = renderCell();

    expect(cell).not.toContain("data-kanban-cell-accent");
    expect(cell).not.toContain("--kanban-cell-accent");
  });

  test("keeps the generic drag-over highlight when active without an accent", () => {
    const cell = renderCell({ active: true });

    expect(cell).toContain("bg-primary/5");
    expect(cell).toContain("ring-primary/50");
    expect(cell).not.toContain("--kanban-cell-accent");
  });

  test("layers a faint accent tint on the resting surface", () => {
    const cell = renderCell({ accent: "blue" });

    expect(cell).toContain('data-kanban-cell-accent="true"');
    expect(cell).toContain("--kanban-cell-accent:var(--option-blue)");
    expect(cell).toContain(
      "background-color:color-mix(in srgb, var(--kanban-cell-accent) 12%, var(--background))",
    );
    // The resting tint never reaches for a ring or the generic highlight.
    expect(cell).not.toContain("box-shadow");
    expect(cell).not.toContain("ring-primary/50");
  });

  test("strengthens the accent into an active wash and ring while a card is over the cell", () => {
    const cell = renderCell({ accent: "blue", active: true });

    expect(cell).toContain('data-kanban-cell-accent="true"');
    expect(cell).toContain(
      "background-color:color-mix(in srgb, var(--kanban-cell-accent) 22%, var(--background))",
    );
    expect(cell).toContain(
      "box-shadow:0 0 0 2px color-mix(in srgb, var(--kanban-cell-accent) 55%, transparent)",
    );
    // The active accent frame replaces the generic primary-coloured one.
    expect(cell).not.toContain("bg-primary/5");
    expect(cell).not.toContain("ring-primary/50");
  });
});
