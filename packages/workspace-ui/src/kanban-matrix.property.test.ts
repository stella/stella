import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import { buildKanbanBoardMatrix, resolveKanbanGrouping } from "@stll/ui/kanban";
import type { KanbanSchema } from "@stll/ui/kanban";

type Row = { id: string; owner: string | null; status: string | null };
type Property = { id: string };

const schema: KanbanSchema<Row, Property> = {
  builtInGroups: [
    {
      id: "_status",
      options: [
        { label: "Open", value: "open" },
        { label: "Done", value: "done" },
      ],
    },
  ],
  getPropertyId: (property) => property.id,
  getPropertyOptions: (property) =>
    property.id === "owner"
      ? [
          { label: "Ada", value: "ada" },
          { label: "Lin", value: "lin" },
        ]
      : null,
  properties: [{ id: "owner" }],
};

const group = resolveKanbanGrouping({ groupBy: "_status", schema });
const subgroup = resolveKanbanGrouping({ groupBy: "owner", schema });

const rowArbitrary: fc.Arbitrary<Row> = fc.record({
  id: fc.uuid(),
  owner: fc.option(fc.constantFrom("ada", "lin", "other"), { nil: null }),
  status: fc.option(fc.constantFrom("open", "done", "other"), { nil: null }),
});

describe("kanban board matrix invariants", () => {
  test("no input card is lost or duplicated, and every cell preserves input order", () => {
    fc.assert(
      fc.property(fc.array(rowArbitrary, { maxLength: 80 }), (rows) => {
        const matrix = buildKanbanBoardMatrix({
          group,
          resolveGroupValue: ({ grouping, row }) => {
            switch (grouping.type) {
              case "built-in":
                return grouping.propertyId === "_status" ? row.status : null;
              case "property":
                return row.owner;
              case "none":
                return null;
              default: {
                const exhaustive: never = grouping;
                return exhaustive;
              }
            }
          },
          rows,
          subgroup,
          uncategorizedLabel: "No value",
        });
        const placed = matrix.cells.flatMap((cell) => cell.rows);

        expect(placed).toHaveLength(rows.length);
        expect(new Set(placed.map((row) => row.id))).toHaveLength(rows.length);
        for (const cell of matrix.cells) {
          let cursor = 0;
          for (const row of cell.rows) {
            const sourceIndex = rows.indexOf(row, cursor);
            expect(sourceIndex).toBeGreaterThanOrEqual(cursor);
            cursor = sourceIndex + 1;
          }
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
