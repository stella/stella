import { describe, expect, test } from "bun:test";

import { validateEntityViewLayout } from "./shared";

const tableLayout = {
  version: 1,
  type: "table",
  columnOrder: [],
  columnPinning: [],
  filters: [],
  sorts: [],
  hiddenProperties: [],
  groupByPropertyId: "_status",
};

describe("entity view persistence boundary", () => {
  test("accepts the supported cross-matter table layout", () => {
    const result = validateEntityViewLayout(tableLayout);
    expect(result.isOk()).toBe(true);
  });

  test("rejects a matter-only custom grouping", () => {
    const result = validateEntityViewLayout({
      ...tableLayout,
      groupByPropertyId: "property-from-a-matter",
    });
    expect(result.isErr()).toBe(true);
  });

  test("rejects duplicate sorts before persistence", () => {
    const result = validateEntityViewLayout({
      ...tableLayout,
      sorts: [
        { propertyId: "_status", desc: false },
        { propertyId: "_status", desc: true },
      ],
    });
    expect(result.isErr()).toBe(true);
  });
});
