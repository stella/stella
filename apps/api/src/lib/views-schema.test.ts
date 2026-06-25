import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { conditionNodeSchema } from "@stll/conditions";

import { tConditionNode } from "@/api/lib/conditions/contract";
import {
  parseViewLayout,
  parseViewLayoutSafe,
  tViewLayoutSchema,
  tViewTemplatePropertySchema,
  viewLayoutSchema,
} from "@/api/lib/views-schema";
import type { ViewLayout } from "@/api/lib/views-schema";

describe("parseViewLayout", () => {
  test("keeps versioned layouts unchanged", () => {
    const layout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: [],
    } satisfies ViewLayout;

    expect(parseViewLayout(layout)).toEqual(layout);
  });

  test("rejects unversioned layouts", () => {
    const layout = {
      type: "calendar",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      datePropertyId: "_created-at",
      mode: "month",
    };

    expect(() => parseViewLayout(layout)).toThrow();
  });
});

describe("parseViewLayoutSafe", () => {
  test("returns a well-formed layout unchanged", () => {
    const layout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: [],
    } satisfies ViewLayout;

    expect(parseViewLayoutSafe(layout)).toEqual(layout);
  });

  test("recovers a layout whose filters use a retired grammar by dropping them", () => {
    // Legacy ViewFilterCondition grammar (field/op/value) that the current AST
    // schema no longer accepts.
    const legacy = {
      version: 1,
      type: "table",
      filters: [{ id: "f1", field: "kind", op: "in", value: ["document"] }],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: ["name"],
    };

    // The strict parser now drops the unparseable legacy filters itself rather
    // than throwing, keeping the table view with an empty filter set...
    expect(parseViewLayout(legacy)).toEqual({
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: ["name"],
    });

    // ...and the safe parser returns the same recovered layout, so one legacy
    // view can't fail the list.
    expect(parseViewLayoutSafe(legacy)).toEqual({
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: ["name"],
    });
  });

  test("drops a filter carrying a formula operand (no SQL transpilation)", () => {
    // A formula operand is a valid AST node (it exists for template rules) but
    // cannot compile to SQL, so a filter that smuggles one in is stripped.
    const withFormula = {
      version: 1,
      type: "table",
      filters: [
        {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "compare",
              left: { type: "formula", expr: "rent * 12" },
              op: "lt",
              right: { type: "literal", value: 100_000 },
            },
          ],
        },
      ],
      sorts: [],
      hiddenProperties: [],
      columnOrder: ["name"],
      columnPinning: [],
    };

    expect(parseViewLayout(withFormula).filters).toEqual([]);
  });

  test("falls back to a minimal layout for an unrecoverable value and never throws", () => {
    expect(parseViewLayoutSafe({ type: "garbage" })).toEqual({
      type: "filesystem",
      version: 1,
      filters: [],
      sorts: [],
      hiddenProperties: [],
    });
    expect(() => parseViewLayoutSafe(null)).not.toThrow();
    expect(() => parseViewLayoutSafe("not a layout")).not.toThrow();
  });
});

describe("view template property validation", () => {
  test("accepts saved AI properties with empty prompts", () => {
    expect(
      Value.Check(tViewTemplatePropertySchema, {
        version: 1,
        sourceId: "source_summary",
        name: "Summary",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "ai-model", prompt: "" },
        createIfMissing: true,
      }),
    ).toBe(true);
  });
});

// Property tests below assert that the two parallel schemas
// (Valibot for internal parsing, TypeBox for the Elysia HTTP boundary) agree on
// every layout and filter shape. Drift between them lets payloads slip past the
// route validator and fail at parseViewLayout, or vice versa.

const arbPropertyId = fc.string({ minLength: 1, maxLength: 16 });
const arbHiddenProperties = fc.array(fc.string({ maxLength: 16 }), {
  maxLength: 5,
});

const arbBuiltinField = fc.constantFrom("status", "priority");
const arbLiteralValue = fc.oneof(
  fc.string({ maxLength: 16 }),
  fc.integer(),
  fc.boolean(),
  fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
);

const arbRefOperand = fc.oneof(
  fc.record({
    type: fc.constant("property" as const),
    propertyId: arbPropertyId,
  }),
  fc.record({ type: fc.constant("builtin" as const), field: arbBuiltinField }),
  fc.record({ type: fc.constant("kind" as const) }),
);

const arbLiteralOperand = fc.record({
  type: fc.constant("literal" as const),
  value: arbLiteralValue,
});

const arbCompareNode = fc.record({
  type: fc.constant("compare" as const),
  left: arbRefOperand,
  op: fc.constantFrom("eq", "neq", "gt", "lt", "gte", "lte"),
  right: arbLiteralOperand,
});

const arbPredicateNode = fc.record(
  {
    type: fc.constant("predicate" as const),
    operand: arbRefOperand,
    op: fc.constantFrom(
      "is_empty",
      "is_truthy",
      "contains",
      "contains_all",
      "in",
    ),
    value: fc.oneof(
      fc.string({ maxLength: 16 }),
      fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
    ),
  },
  { requiredKeys: ["type", "operand", "op"] },
);

const arbFilter = fc.oneof(arbCompareNode, arbPredicateNode);

const arbSort = fc.record({
  propertyId: arbPropertyId,
  desc: fc.boolean(),
});

const baseLayoutFields = {
  version: fc.constant(1 as const),
  filters: fc.array(arbFilter, { maxLength: 4 }),
  sorts: fc.array(arbSort, { maxLength: 4 }),
  hiddenProperties: arbHiddenProperties,
};

const arbLayout = fc.oneof(
  fc.record({ type: fc.constant("overview" as const), ...baseLayoutFields }),
  fc.record({
    type: fc.constant("table" as const),
    columnOrder: fc.array(fc.string({ maxLength: 16 }), { maxLength: 5 }),
    columnPinning: fc.array(fc.string({ maxLength: 16 }), { maxLength: 5 }),
    ...baseLayoutFields,
  }),
  fc.record({
    type: fc.constant("filesystem" as const),
    ...baseLayoutFields,
  }),
  fc.record(
    {
      type: fc.constant("kanban" as const),
      ...baseLayoutFields,
      groupByPropertyId: arbPropertyId,
    },
    {
      requiredKeys: ["type", "version", "filters", "sorts", "hiddenProperties"],
    },
  ),
  fc.record(
    {
      type: fc.constant("calendar" as const),
      ...baseLayoutFields,
      datePropertyId: arbPropertyId,
      endDatePropertyId: arbPropertyId,
      additionalDatePropertyIds: fc.array(arbPropertyId, { maxLength: 3 }),
      mode: fc.constantFrom("month", "week", "year"),
    },
    {
      requiredKeys: [
        "type",
        "version",
        "filters",
        "sorts",
        "hiddenProperties",
        "datePropertyId",
        "mode",
      ],
    },
  ),
  fc.record(
    {
      type: fc.constant("timeline" as const),
      ...baseLayoutFields,
      startDatePropertyId: arbPropertyId,
      endDatePropertyId: arbPropertyId,
      zoom: fc.constantFrom("day", "week", "month", "quarter"),
      groupByPropertyId: arbPropertyId,
      showTable: fc.boolean(),
    },
    {
      requiredKeys: [
        "type",
        "version",
        "filters",
        "sorts",
        "hiddenProperties",
        "startDatePropertyId",
        "endDatePropertyId",
        "zoom",
        "showTable",
      ],
    },
  ),
);

const declaredLayoutKeys = new Set([
  "type",
  "version",
  "filters",
  "sorts",
  "hiddenProperties",
  "columnOrder",
  "columnPinning",
  "groupByPropertyId",
  "datePropertyId",
  "endDatePropertyId",
  "additionalDatePropertyIds",
  "mode",
  "startDatePropertyId",
  "zoom",
  "showTable",
]);

// Valibot 1.4.0's strictObject uses `key in this.entries` to detect extra keys,
// which walks the prototype chain — so names like "valueOf"/"toString" are
// silently treated as known and stripped from output. TypeBox correctly
// rejects them. Excluding these names from the parity property keeps the
// signal clean; the divergence is captured separately below.
const objectPrototypeKeys = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

describe("conditionNodeSchema — properties", () => {
  test("Valibot and TypeBox agree on every well-formed condition node", () => {
    fc.assert(
      fc.property(arbFilter, (filter) => {
        expect(v.is(conditionNodeSchema, filter)).toBe(true);
        expect(Value.Check(tConditionNode, filter)).toBe(true);
      }),
    );
  });
});

describe("viewLayoutSchema — properties", () => {
  test("Valibot and TypeBox agree on every well-formed layout", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        expect(v.is(viewLayoutSchema, layout)).toBe(true);
        expect(Value.Check(tViewLayoutSchema, layout)).toBe(true);
      }),
    );
  });

  test("parseViewLayout is identity on well-formed layouts", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        expect(parseViewLayout(layout)).toEqual(layout as ViewLayout);
      }),
    );
  });

  test("both schemas reject layouts with an undeclared extra key", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc
          .string({ minLength: 1, maxLength: 16 })
          .filter(
            (key) =>
              !declaredLayoutKeys.has(key) && !objectPrototypeKeys.has(key),
          ),
        (layout, extraKey) => {
          const polluted = { ...layout, [extraKey]: "junk" };
          expect(v.is(viewLayoutSchema, polluted)).toBe(false);
          expect(Value.Check(tViewLayoutSchema, polluted)).toBe(false);
        },
      ),
    );
  });

  // Known divergence: Valibot 1.4.0 fails to reject Object.prototype-named extra
  // keys because its strictObject check walks the prototype chain. TypeBox is
  // strict. Practical impact is limited (Elysia rejects at the HTTP boundary via
  // TypeBox), but parseViewLayout is also called on DB rows. If this starts
  // failing after a Valibot upgrade, swap the comparison and delete this note.
  test("Valibot accepts Object.prototype-named extra keys that TypeBox rejects", () => {
    const polluted = {
      type: "kanban" as const,
      version: 1 as const,
      filters: [],
      sorts: [],
      hiddenProperties: [],
      groupByPropertyId: "x",
      valueOf: "junk",
    };
    expect(v.is(viewLayoutSchema, polluted)).toBe(true);
    expect(Value.Check(tViewLayoutSchema, polluted)).toBe(false);
  });
});
