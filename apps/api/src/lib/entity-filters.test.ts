import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import type { ConditionNode } from "@stll/conditions";

import {
  applyFilters,
  applySorts,
  buildSortExpressions,
  buildFilterConditions,
} from "./entity-filters";

// -- buildFilterConditions (builtin filters) --

const builtinCompare = (
  field: "status" | "priority",
  op: "eq" | "neq",
  value: string,
): ConditionNode => ({
  type: "compare",
  left: { type: "builtin", field },
  op,
  right: { type: "literal", value },
});

const builtinPredicate = (
  field: "status" | "priority",
  op: "in" | "is_empty",
  value?: string[],
): ConditionNode => ({
  type: "predicate",
  operand: { type: "builtin", field },
  op,
  ...(value !== undefined && { value }),
});

describe("buildFilterConditions (builtin)", () => {
  test("eq with empty string returns no conditions", () => {
    const conds = buildFilterConditions([builtinCompare("status", "eq", "")]);
    expect(conds).toHaveLength(0);
  });

  test("eq with valid value returns one condition", () => {
    const conds = buildFilterConditions([
      builtinCompare("status", "eq", "open"),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("neq with empty string returns no conditions", () => {
    const conds = buildFilterConditions([builtinCompare("status", "neq", "")]);
    expect(conds).toHaveLength(0);
  });

  test("neq with valid value returns one condition", () => {
    const conds = buildFilterConditions([
      builtinCompare("status", "neq", "done"),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("in with empty array returns no conditions", () => {
    const conds = buildFilterConditions([builtinPredicate("status", "in", [])]);
    expect(conds).toHaveLength(0);
  });

  test("in with values returns one condition", () => {
    const conds = buildFilterConditions([
      builtinPredicate("status", "in", ["open", "done"]),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("is_empty returns one condition", () => {
    const conds = buildFilterConditions([
      builtinPredicate("status", "is_empty"),
    ]);
    expect(conds).toHaveLength(1);
  });

  test("multiple filters produce multiple conditions", () => {
    const conds = buildFilterConditions([
      builtinCompare("status", "eq", "open"),
      builtinCompare("priority", "neq", "low"),
    ]);
    expect(conds).toHaveLength(2);
  });
});

// -- buildFilterConditions (kind filters) --

const kindIn = (value: string[]): ConditionNode => ({
  type: "predicate",
  operand: { type: "kind" },
  op: "in",
  value,
});

describe("buildFilterConditions (kind)", () => {
  test("kind filter with empty value produces no conditions", () => {
    const conds = buildFilterConditions([kindIn([])]);
    expect(conds).toHaveLength(0);
  });

  test("kind filter with values produces one condition", () => {
    const conds = buildFilterConditions([kindIn(["task"])]);
    expect(conds).toHaveLength(1);
  });

  test("kind filter including document expands to folder", () => {
    const dialect = new PgDialect();
    const [cond] = buildFilterConditions([kindIn(["document"])]);
    if (!cond) {
      throw new Error("expected kind condition");
    }
    const { sql, params } = dialect.sqlToQuery(cond);
    expect(sql).toContain('"kind"');
    expect(params).toContain("folder");
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

const propertyCompare = (
  propertyId: string,
  op: "eq" | "neq",
  value: string,
): ConditionNode => ({
  type: "compare",
  left: { type: "property", propertyId },
  op,
  right: { type: "literal", value },
});

const propertyPredicate = (
  propertyId: string,
  op: "contains" | "is_empty",
  value?: string,
): ConditionNode => ({
  type: "predicate",
  operand: { type: "property", propertyId },
  op,
  ...(value !== undefined && { value }),
});

describe("applyFilters (in-memory)", () => {
  test("empty filters returns all items", () => {
    const items = [makeEntity("1", "task"), makeEntity("2", "task")];
    expect(applyFilters(items, [])).toHaveLength(2);
  });

  test("kind filter includes matching entities", () => {
    const items = [makeEntity("1", "task"), makeEntity("2", "document")];
    const filtered = applyFilters(items, [kindIn(["task"])]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("1");
  });

  test("kind filter with 'document' includes folders", () => {
    const items = [
      makeEntity("1", "document"),
      makeEntity("2", "folder"),
      makeEntity("3", "task"),
    ];
    const filtered = applyFilters(items, [kindIn(["document"])]);
    expect(filtered).toHaveLength(2);
  });

  test("property eq filter matches exact value", () => {
    const items = [
      makeEntity("1", "task", [["p1", "alpha"]]),
      makeEntity("2", "task", [["p1", "beta"]]),
    ];
    const filtered = applyFilters(items, [
      propertyCompare("p1", "eq", "alpha"),
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
      propertyCompare("p1", "neq", "alpha"),
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
      propertyPredicate("p1", "contains", "hello"),
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("1");
  });

  test("property is_empty matches missing fields", () => {
    const items = [
      makeEntity("1", "task", [["p1", "value"]]),
      makeEntity("2", "task", []),
    ];
    const filtered = applyFilters(items, [propertyPredicate("p1", "is_empty")]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entityId).toBe("2");
  });

  test("builtin filters pass through in-memory (always true)", () => {
    const items = [makeEntity("1", "task"), makeEntity("2", "task")];
    // Builtin filters are server-side only; nodes referencing builtin
    // operands pass through in-memory.
    const filtered = applyFilters(items, [
      builtinCompare("status", "eq", "open"),
    ]);
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

  test("orders ints numerically, not lexicographically (10 after 9)", () => {
    const items = [
      {
        entityId: "ten",
        kind: "task" as const,
        fields: [makeIntField("ten", "p1", 10)],
      },
      {
        entityId: "nine",
        kind: "task" as const,
        fields: [makeIntField("nine", "p1", 9)],
      },
      {
        entityId: "two",
        kind: "task" as const,
        fields: [makeIntField("two", "p1", 2)],
      },
    ];

    const sorted = applySorts(items, [{ propertyId: "p1", desc: false }]);

    expect(sorted.map((item) => item.entityId)).toEqual(["two", "nine", "ten"]);
  });

  test("int sort stays numeric when a row is missing the field (missing sorts last)", () => {
    const items = [
      {
        entityId: "ten",
        kind: "task" as const,
        fields: [makeIntField("ten", "p1", 10)],
      },
      { entityId: "missing", kind: "task" as const, fields: [] },
      {
        entityId: "nine",
        kind: "task" as const,
        fields: [makeIntField("nine", "p1", 9)],
      },
    ];

    const asc = applySorts(items, [{ propertyId: "p1", desc: false }]);
    expect(asc.map((item) => item.entityId)).toEqual([
      "nine",
      "ten",
      "missing",
    ]);

    // Missing values bucket to the end regardless of direction.
    const desc = applySorts(items, [{ propertyId: "p1", desc: true }]);
    expect(desc.map((item) => item.entityId)).toEqual([
      "ten",
      "nine",
      "missing",
    ]);
  });

  test("int sort treats whitespace-only legacy text as missing", () => {
    const items = [
      makeEntity("whitespace", "task", [["p1", "   "]]),
      {
        entityId: "negative",
        kind: "task" as const,
        fields: [makeIntField("negative", "p1", -1)],
      },
      {
        entityId: "positive",
        kind: "task" as const,
        fields: [makeIntField("positive", "p1", 1)],
      },
    ];

    const sorted = applySorts(items, [{ propertyId: "p1", desc: false }]);

    expect(sorted.map((item) => item.entityId)).toEqual([
      "negative",
      "positive",
      "whitespace",
    ]);
  });

  test("int sort parses legacy numeric text values", () => {
    const items = [
      {
        entityId: "twenty",
        kind: "task" as const,
        fields: [makeIntField("twenty", "p1", 20)],
      },
      makeEntity("ten", "task", [["p1", "10"]]),
      {
        entityId: "nine",
        kind: "task" as const,
        fields: [makeIntField("nine", "p1", 9)],
      },
    ];

    const sorted = applySorts(items, [{ propertyId: "p1", desc: false }]);

    expect(sorted.map((item) => item.entityId)).toEqual([
      "nine",
      "ten",
      "twenty",
    ]);
  });

  test("property: int sort with missing rows is numerically monotonic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.integer(), { nil: undefined }), {
          minLength: 1,
          maxLength: 20,
        }),
        (values) => {
          const items = values.map((value, index) =>
            value === undefined
              ? { entityId: String(index), kind: "task" as const, fields: [] }
              : {
                  entityId: String(index),
                  kind: "task" as const,
                  fields: [makeIntField(String(index), "p1", value)],
                },
          );

          const sorted = applySorts(items, [{ propertyId: "p1", desc: false }]);
          const nums = sorted.map((item) => {
            const c = item.fields[0]?.content;
            return c?.type === "int" ? c.value : null;
          });

          // Defined ints appear before any missing, in non-decreasing order.
          let seenNull = false;
          let prev = -Infinity;
          for (const n of nums) {
            if (n === null) {
              seenNull = true;
              continue;
            }
            expect(seenNull).toBe(false);
            expect(n).toBeGreaterThanOrEqual(prev);
            prev = n;
          }
        },
      ),
    );
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

describe("buildSortExpressions", () => {
  test("_name sort uses the materialized display name", () => {
    const [nameSort] = buildSortExpressions([
      { propertyId: "_name", desc: false },
    ]);
    if (!nameSort) {
      throw new Error("expected _name sort expression");
    }

    const dialect = new PgDialect();
    const sql = dialect.sqlToQuery(nameSort).sql;

    expect(sql).toBe('"entities"."display_name" ASC');
  });

  test("metadata table sorts use entity columns, not property field subqueries", () => {
    const dialect = new PgDialect();
    const sortCases = [
      { propertyId: "_created-at", column: '"created_at"' },
      { propertyId: "_status", column: '"status"' },
      { propertyId: "_priority", column: '"priority"' },
      { propertyId: "_due-date", column: '"due_date"' },
    ];

    for (const { propertyId, column } of sortCases) {
      const [sortExpression] = buildSortExpressions([
        { propertyId, desc: false },
      ]);
      if (!sortExpression) {
        throw new Error(`expected ${propertyId} sort expression`);
      }

      const sql = dialect.sqlToQuery(sortExpression).sql;

      expect(sql).toContain(`"entities".${column}`);
      expect(sql).not.toContain('"fields"."property_id" =');
    }
  });

  test("property sort emits a numeric key so int fields order numerically", () => {
    const dialect = new PgDialect();
    const expressions = buildSortExpressions([
      { propertyId: "p1", desc: false },
    ]);

    // A guarded numeric cast, ordered before the text key.
    const numericExpr = expressions[0];
    const textExpr = expressions[1];
    if (!numericExpr || !textExpr) {
      throw new Error("expected numeric and text sort expressions");
    }

    const numericSql = dialect.sqlToQuery(numericExpr).sql;
    expect(numericSql).toContain("::numeric");
    expect(numericSql).toContain("BTRIM");
    expect(numericSql).toContain('"properties"');
    expect(numericSql).toContain("'int'");
    expect(numericSql).toContain("~");
    expect(numericSql).toContain("NULLS LAST");

    const textSql = dialect.sqlToQuery(textExpr).sql;
    expect(textSql).toContain("->>'value'");
    expect(textSql).not.toContain("::numeric");
  });

  test("descending property sort keeps missing/non-int values last", () => {
    const dialect = new PgDialect();
    const [numericExpr] = buildSortExpressions([
      { propertyId: "p1", desc: true },
    ]);
    if (!numericExpr) {
      throw new Error("expected numeric sort expression");
    }
    const sql = dialect.sqlToQuery(numericExpr).sql;
    expect(sql).toContain("DESC NULLS LAST");
  });
});
