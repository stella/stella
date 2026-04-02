import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { ViewFilterCondition } from "@/api/handlers/registry/actors/views/schema";

import {
  applyFilters,
  applySorts,
  buildFilterConditions,
} from "./entity-filters";

// -- buildFilterConditions (builtin filters) --

const builtinFilter = (
  overrides: Partial<Extract<ViewFilterCondition, { field: "builtin" }>>,
): ViewFilterCondition =>
  ({
    id: "f1",
    field: "builtin" as const,
    builtinField: "status" as const,
    op: "eq" as const,
    value: undefined,
    ...overrides,
  }) as ViewFilterCondition;

describe("buildFilterConditions (builtin)", () => {
  test("eq with empty string returns no conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "eq", value: "" }),
    ]);
    expect(conds).toHaveLength(0);
  });

  test("eq with undefined value returns no conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "eq", value: undefined }),
    ]);
    expect(conds).toHaveLength(0);
  });

  test("eq with valid value returns one condition", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "eq", value: "open" }),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("neq with empty string returns no conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "neq", value: "" }),
    ]);
    expect(conds).toHaveLength(0);
  });

  test("neq with undefined value returns no conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "neq", value: undefined }),
    ]);
    expect(conds).toHaveLength(0);
  });

  test("neq with valid value returns one condition", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "neq", value: "done" }),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("in with empty array returns no conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "in", value: [] }),
    ]);
    expect(conds).toHaveLength(0);
  });

  test("in with values returns one condition", () => {
    const conds = buildFilterConditions([
      builtinFilter({ op: "in", value: ["open", "done"] }),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("is_empty returns one condition", () => {
    const conds = buildFilterConditions([builtinFilter({ op: "is_empty" })]);
    expect(conds).toHaveLength(1);
  });

  test("unknown builtinField returns no conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentionally invalid value
        builtinField: "nonexistent" as "status",
      }),
    ]);
    expect(conds).toHaveLength(0);
  });

  test("multiple filters produce multiple conditions", () => {
    const conds = buildFilterConditions([
      builtinFilter({
        id: "f1",
        builtinField: "status",
        op: "eq",
        value: "open",
      }),
      builtinFilter({
        id: "f2",
        builtinField: "priority",
        op: "neq",
        value: "low",
      }),
    ]);
    expect(conds).toHaveLength(2);
  });
});

// -- buildFilterConditions (kind filters) --

describe("buildFilterConditions (kind)", () => {
  test("kind filter with empty value produces no conditions", () => {
    const conds = buildFilterConditions([
      {
        id: "f1",
        field: "kind",
        op: "in",
        value: [],
      },
    ]);
    expect(conds).toHaveLength(0);
  });

  test("kind filter with values produces one condition", () => {
    const conds = buildFilterConditions([
      {
        id: "f1",
        field: "kind",
        op: "in",
        value: ["task"],
      },
    ]);
    expect(conds).toHaveLength(1);
  });
});

// -- applyFilters (in-memory) --

type TestEntity = {
  entityId: string;
  kind: "task" | "document" | "folder" | "message";
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: { type: "text"; version: 1; value: string };
  }[];
};

const makeEntity = (
  id: string,
  kind: TestEntity["kind"],
  fieldEntries: [string, string][] = [],
): TestEntity => ({
  entityId: id,
  kind,
  fields: fieldEntries.map(([propId, value]) => ({
    id: `field_${propId}_${id}`,
    propertyId: propId,
    entityId: id,
    content: { type: "text" as const, version: 1 as const, value },
  })),
});

const makeIntField = (entityId: string, propertyId: string, value: number) => ({
  id: `field_${propertyId}_${entityId}`,
  propertyId,
  entityId,
  content: {
    type: "int" as const,
    version: 1 as const,
    value,
    currency: null,
  },
});

describe("applyFilters (in-memory)", () => {
  test("empty filters returns all items", () => {
    const items = [makeEntity("1", "task"), makeEntity("2", "task")];
    expect(applyFilters(items, [])).toHaveLength(2);
  });

  test("kind filter includes matching entities", () => {
    const items = [makeEntity("1", "task"), makeEntity("2", "document")];
    const filtered = applyFilters(items, [
      { id: "f1", field: "kind", op: "in", value: ["task"] },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("1");
  });

  test("kind filter with 'document' includes folders", () => {
    const items = [
      makeEntity("1", "document"),
      makeEntity("2", "folder"),
      makeEntity("3", "task"),
    ];
    const filtered = applyFilters(items, [
      { id: "f1", field: "kind", op: "in", value: ["document"] },
    ]);
    expect(filtered).toHaveLength(2);
  });

  test("property eq filter matches exact value", () => {
    const items = [
      makeEntity("1", "task", [["p1", "alpha"]]),
      makeEntity("2", "task", [["p1", "beta"]]),
    ];
    const filtered = applyFilters(items, [
      {
        id: "f1",
        field: "property",
        propertyId: "p1",
        op: "eq",
        value: "alpha",
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("1");
  });

  test("property neq filter excludes matching value", () => {
    const items = [
      makeEntity("1", "task", [["p1", "alpha"]]),
      makeEntity("2", "task", [["p1", "beta"]]),
    ];
    const filtered = applyFilters(items, [
      {
        id: "f1",
        field: "property",
        propertyId: "p1",
        op: "neq",
        value: "alpha",
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("2");
  });

  test("property contains filter is case-insensitive", () => {
    const items = [
      makeEntity("1", "task", [["p1", "Hello World"]]),
      makeEntity("2", "task", [["p1", "goodbye"]]),
    ];
    const filtered = applyFilters(items, [
      {
        id: "f1",
        field: "property",
        propertyId: "p1",
        op: "contains",
        value: "hello",
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("1");
  });

  test("property is_empty matches missing fields", () => {
    const items = [
      makeEntity("1", "task", [["p1", "value"]]),
      makeEntity("2", "task", []),
    ];
    const filtered = applyFilters(items, [
      {
        id: "f1",
        field: "property",
        propertyId: "p1",
        op: "is_empty",
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("2");
  });

  test("builtin filters pass through in-memory (always true)", () => {
    const items = [makeEntity("1", "task"), makeEntity("2", "task")];
    const filtered = applyFilters(items, [
      {
        id: "f1",
        field: "builtin",
        builtinField: "status",
        op: "eq",
        value: "open",
      },
    ]);
    // Builtin filters are server-side only; in-memory always
    // returns true
    expect(filtered).toHaveLength(2);
  });
});

describe("applySorts (in-memory)", () => {
  test("empty sorts returns the original order", () => {
    const items = [
      makeEntity("1", "task", [["p1", "beta"]]),
      makeEntity("2", "task", [["p1", "alpha"]]),
    ];

    expect(applySorts(items, [])).toEqual(items);
  });

  test("sorts string values ascending", () => {
    const items = [
      makeEntity("1", "task", [["p1", "beta"]]),
      makeEntity("2", "task", [["p1", "alpha"]]),
    ];

    const sorted = applySorts(items, [{ propertyId: "p1", desc: false }]);

    expect(sorted.map((item) => item.entityId)).toEqual(["2", "1"]);
  });

  test("sorts integer values descending", () => {
    const items = [
      {
        entityId: "1",
        kind: "task" as const,
        fields: [makeIntField("1", "p1", 2)],
      },
      {
        entityId: "2",
        kind: "task" as const,
        fields: [makeIntField("2", "p1", 9)],
      },
    ];

    const sorted = applySorts(items, [{ propertyId: "p1", desc: true }]);

    expect(sorted.map((item) => item.entityId)).toEqual(["2", "1"]);
  });

  test("property: ascending string sort is monotonic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        (values) => {
          const items = values.map((value, index) =>
            makeEntity(String(index), "task", [["p1", value]]),
          );

          const sorted = applySorts(items, [{ propertyId: "p1", desc: false }]);
          const extracted = sorted.map((item) => item.fields[0]?.content.value);

          for (const [index, value] of extracted.entries()) {
            if (value === undefined) {
              continue;
            }
            const next = extracted.at(index + 1);
            if (next === undefined) {
              continue;
            }
            expect(value.localeCompare(next)).toBeLessThanOrEqual(0);
          }
        },
      ),
    );
  });

  test("property: descending int sort is monotonic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 20 }),
        (values) => {
          const items = values.map((value, index) => ({
            entityId: String(index),
            kind: "task" as const,
            fields: [makeIntField(String(index), "p1", value)],
          }));

          const sorted = applySorts(items, [{ propertyId: "p1", desc: true }]);
          const extracted = sorted.map((item) =>
            item.fields[0]?.content.type === "int"
              ? item.fields[0].content.value
              : Number.NaN,
          );

          expect(extracted).toEqual([...extracted].toSorted((a, b) => b - a));
        },
      ),
    );
  });
});
