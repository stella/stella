/**
 * Property sweep over the kit's kanban grouping.
 *
 * It lives here rather than beside the module it exercises because
 * `@stll/property-testing` is a private workspace package: the design system
 * has to build, test and typecheck with nothing but its declared dependencies,
 * so it carries example-based tests and the sweep runs from a workspace that
 * already depends on both.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import type { KanbanGroupOption, KanbanSchema } from "@stll/ui/kanban";
import {
  getKanbanGroupingPropertyId,
  getKanbanGroups,
  resolveKanbanGrouping,
  selectKanbanRows,
} from "@stll/ui/kanban";

type Row = { id: string; kind: string };
type Property = { id: string; groupable: boolean };

const option = (value: string): KanbanGroupOption => ({ value, label: value });

const schema: KanbanSchema<Row, Property> = {
  builtInGroups: [
    {
      id: "_status",
      options: [option("open"), option("done")],
      selectRows: (rows) => rows.filter((row) => row.kind === "task"),
    },
    { id: "_kind", options: [option("document"), option("task")] },
  ],
  properties: [
    { id: "phase", groupable: true },
    { id: "notes", groupable: false },
  ],
  getPropertyId: (property) => property.id,
  getPropertyOptions: (property) =>
    property.groupable ? [option("one"), option("two")] : null,
};

const GROUP_BY_IDS = ["_status", "_kind", "phase", "notes", "", "_nope"];

const rowArb: fc.Arbitrary<Row> = fc.record({
  id: fc.string({ minLength: 1 }),
  kind: fc.constantFrom("document", "folder", "task"),
});

describe("kanban grouping invariants", () => {
  test("the board scope is a subsequence of its input: no row is invented, duplicated, or reordered", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb),
        fc.constantFrom(...GROUP_BY_IDS),
        (rows, groupBy) => {
          const selected = selectKanbanRows(
            rows,
            resolveKanbanGrouping({ groupBy, schema }),
          );

          let cursor = 0;
          for (const row of selected) {
            const found = rows.indexOf(row, cursor);
            expect(found).toBeGreaterThanOrEqual(cursor);
            cursor = found + 1;
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("the group-by id round-trips through the resolved grouping", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GROUP_BY_IDS), (groupBy) => {
        const resolved = getKanbanGroupingPropertyId(
          resolveKanbanGrouping({ groupBy, schema }),
        );
        const known = ["_status", "_kind", "phase", "notes"].includes(groupBy);

        expect(resolved).toBe(known ? groupBy : null);
      }),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("the uncategorized bucket comes last, exactly once, after every option in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }).map(option)),
        fc.string({ minLength: 1 }),
        (options, uncategorized) => {
          const groups = getKanbanGroups(options, uncategorized);

          expect(groups).toHaveLength(options.length + 1);
          expect(groups.filter((group) => group.value === null)).toHaveLength(
            1,
          );
          expect(groups.at(-1)?.value).toBeNull();
          expect(groups.at(-1)?.label).toBe(uncategorized);
          expect(groups.slice(0, -1).map((group) => group.value)).toEqual(
            options.map((candidate) => candidate.value),
          );
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
