import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KANBAN_STICKY_TOP_CLASS } from "./sticky-lane";
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

const renderMarkup = (
  overrides: Partial<KanbanVirtualCellProps<string>> = {},
) =>
  renderToStaticMarkup(
    <KanbanVirtualCell
      getRowKey={(row) => row}
      pagination={{ type: "none" }}
      renderRow={(row) => <span>{row}</span>}
      rows={["one"]}
      {...overrides}
    />,
  );

const renderCell = (overrides: Partial<KanbanVirtualCellProps<string>> = {}) =>
  readCell(renderMarkup(overrides));

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

describe("KanbanVirtualCell footer placement", () => {
  const action = <button type="button">Add card</button>;
  // The virtualizer measures nothing without a live scroll element, so the
  // rows' own container stands in for where the rows begin.
  const rowsAt = (markup: string) => markup.indexOf('<div class="relative"');
  /** The pinned row itself, and the surface it repaints inside it. */
  const readPinned = (markup: string) => {
    const match =
      /<div class="(?<sticky>[^"]*)" data-kanban-cell-footer="sticky-start"><div class="(?<surface>[^"]*)"/u.exec(
        markup,
      );

    if (!match?.groups) {
      throw new Error("no pinned footer in the rendered markup");
    }

    return match.groups;
  };

  test("closes the cell with the action by default", () => {
    const markup = renderMarkup({ footer: action });

    expect(markup).not.toContain("data-kanban-cell-footer");
    expect(markup.indexOf("Add card")).toBeGreaterThan(rowsAt(markup));
  });

  test("pins the action above the rows under the board's header offset", () => {
    const markup = renderMarkup({
      footer: action,
      footerPlacement: "sticky-start",
    });
    const { sticky, surface } = readPinned(markup);

    expect(sticky).toContain("sticky");
    expect(sticky).toContain(KANBAN_STICKY_TOP_CLASS);
    // Cards pass behind the action: the cell's surface over an opaque base.
    expect(sticky).toContain("bg-background");
    expect(surface).toContain("bg-muted/20");
    // The action leads the rows, and keeps their bottom padding so nothing
    // below it shifts.
    expect(surface).toContain("pb-2");
    expect(markup.indexOf("Add card")).toBeLessThan(rowsAt(markup));
  });

  test("repaints an accented cell's own surface behind the pinned action", () => {
    const markup = renderMarkup({
      accent: "blue",
      footer: action,
      footerPlacement: "sticky-start",
    });

    expect(readCell(markup)).toContain(
      "--kanban-cell-surface:color-mix(in srgb, var(--kanban-cell-accent) 12%, var(--background))",
    );
    // The accent wash replaces the neutral surface over the opaque base.
    const { surface } = readPinned(markup);

    expect(surface).toContain("bg-(--kanban-cell-surface)");
    expect(surface).not.toContain("bg-muted/20");
  });

  test("pins no empty row when the cell has no action", () => {
    expect(renderMarkup({ footerPlacement: "sticky-start" })).not.toContain(
      "data-kanban-cell-footer",
    );
  });
});
