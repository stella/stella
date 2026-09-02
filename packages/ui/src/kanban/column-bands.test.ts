import { describe, expect, test } from "bun:test";

import { hasKanbanColumnBands, resolveKanbanColumnBands } from "./column-bands";
import type { KanbanColumnBand } from "./grouping";
import type { KanbanBoardColumn } from "./matrix";

const todo: KanbanColumnBand = { id: "todo", label: "To do" };
const doing: KanbanColumnBand = { id: "doing", label: "In progress" };

const column = (value: string, band?: KanbanColumnBand): KanbanBoardColumn => ({
  group: { label: value, value, ...(band === undefined ? {} : { band }) },
  type: "group",
});
const archive: KanbanBoardColumn = {
  destination: { id: "archive", label: "Archive" },
  type: "destination",
};

describe("resolveKanbanColumnBands", () => {
  test("groups adjacent columns of one band and leaves the rest alone", () => {
    const spans = resolveKanbanColumnBands([
      column("backlog"),
      column("open", todo),
      column("blocked", todo),
      column("active", doing),
      archive,
    ]);

    expect(
      spans.map((span) => [
        span.band?.id ?? null,
        span.columns.map((candidate) =>
          candidate.type === "group"
            ? candidate.group.value
            : candidate.destination.id,
        ),
      ]),
    ).toEqual([
      [null, ["backlog"]],
      ["todo", ["open", "blocked"]],
      ["doing", ["active"]],
      [null, ["archive"]],
    ]);
  });

  test("keeps every column, in order, across the spans", () => {
    const columns = [
      column("a", todo),
      column("b", todo),
      column("c"),
      column("d", doing),
    ];
    const spans = resolveKanbanColumnBands(columns);

    expect(spans.flatMap((span) => span.columns)).toEqual(columns);
  });

  test("rejects a band that resumes after another column", () => {
    expect(() =>
      resolveKanbanColumnBands([
        column("open", todo),
        column("active", doing),
        column("blocked", todo),
      ]),
    ).toThrow(/not contiguous/u);
  });

  test("reports whether any column carries a band", () => {
    expect(hasKanbanColumnBands([column("a"), archive])).toBe(false);
    expect(hasKanbanColumnBands([column("a"), column("b", todo)])).toBe(true);
  });
});
