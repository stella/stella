/**
 * Property sweep over the kit's table schema.
 *
 * It lives here rather than beside the module it exercises for the same reason
 * the kanban sweep does: `@stll/property-testing` is a private workspace
 * package, and the design system has to build and test with nothing but its
 * declared dependencies.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import type { TableSchema } from "@stll/ui/data-table";
import {
  hideableColumnIds,
  tableColumnIds,
  visibleColumnIds,
} from "@stll/ui/data-table";

type Render = { type: string };

const column = (id: string, hide: boolean, size: number) => ({
  id,
  label: id,
  render: { type: id },
  size,
  capabilities: { sort: true, hide, resize: true, pin: true },
  emphasis: "content" as const,
});

const schema = (columns: ReturnType<typeof column>[]): TableSchema<Render> => ({
  columns,
  defaultMinSize: 64,
});

// Ids are unique: a repeated id is a schema bug in its own right, which
// `duplicateColumnIds` is there to catch.
const columnsArb = fc
  .uniqueArray(fc.constantFrom("a", "b", "c", "d"), { maxLength: 4 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc
          .tuple(fc.boolean(), fc.integer({ min: 40, max: 400 }))
          .map(([hide, size]) => column(id, hide, size)),
      ),
    ),
  );

describe("table schema invariants", () => {
  test("the visible columns are a subsequence of the schema's, and hiding is idempotent", () => {
    fc.assert(
      fc.property(
        columnsArb,
        fc.array(fc.constantFrom("a", "b", "c", "d")),
        (columns, hidden) => {
          const example = schema([...columns]);
          const visible = visibleColumnIds(example, hidden);
          const all = tableColumnIds(example);

          let cursor = 0;
          for (const id of visible) {
            const found = all.indexOf(id, cursor);
            expect(found).toBeGreaterThanOrEqual(cursor);
            cursor = found + 1;
          }

          expect(visibleColumnIds(example, hidden)).toEqual(visible);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("hiding nothing shows everything", () => {
    fc.assert(
      fc.property(columnsArb, (columns) => {
        const example = schema([...columns]);

        expect(visibleColumnIds(example, [])).toEqual(tableColumnIds(example));
      }),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("every hideable column can be hidden, and no other column can", () => {
    fc.assert(
      fc.property(columnsArb, (columns) => {
        const example = schema([...columns]);
        const visible = new Set(
          visibleColumnIds(example, tableColumnIds(example)),
        );
        const hideable = new Set(hideableColumnIds(example));

        for (const id of tableColumnIds(example)) {
          expect(visible.has(id)).toBe(!hideable.has(id));
        }
      }),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
