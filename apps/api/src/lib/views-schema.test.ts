import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { VIEW_SORTS_MAX } from "@stll/api-contract";
import { CALCULATION_KINDS } from "@stll/calculations";
import { BUILTIN_FIELDS, conditionNodeSchema } from "@stll/conditions";
import { assertProperty } from "@stll/property-testing";

import { tConditionNode } from "@/api/lib/conditions/contract";
import { brandPersistedLegalListId } from "@/api/lib/safe-id-boundaries";
import {
  parseStoredViewLayout,
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
      calculations: [],
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
      calculations: [],
      datePropertyId: "_created-at",
      mode: "month",
    };

    expect(() => parseViewLayout(layout)).toThrow(
      'Invalid key: Expected "version" but received undefined',
    );
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
      calculations: [],
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
      calculations: [],
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
      calculations: [],
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
      calculations: [],
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
      calculations: [],
      columnOrder: ["name"],
      columnPinning: [],
    };

    expect(parseViewLayout(withFormula).filters).toEqual([]);
    expect(parseViewLayoutSafe(withFormula).filters).toEqual([]);
  });

  test("falls back to a minimal layout for an unrecoverable value and never throws", () => {
    expect(parseViewLayoutSafe({ type: "garbage" })).toEqual({
      type: "filesystem",
      version: 1,
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
    });
    expect(() => parseViewLayoutSafe(null)).not.toThrow();
    expect(() => parseViewLayoutSafe("not a layout")).not.toThrow();
  });
});

describe("sort cap", () => {
  const oversizedSorts = Array.from({ length: VIEW_SORTS_MAX + 1 }, (_, i) => ({
    propertyId: `prop-${i}`,
    desc: i % 2 === 0,
  }));
  const oversizedLayout = {
    version: 1,
    type: "table",
    filters: [],
    sorts: oversizedSorts,
    hiddenProperties: [],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
  } as const;

  test("fixture exceeds the cap", () => {
    expect(oversizedSorts.length).toBeGreaterThan(VIEW_SORTS_MAX);
  });

  test("a stored layout over the cap reads back with the leading sorts kept", () => {
    const parsed = parseStoredViewLayout(oversizedLayout);
    expect(parsed.sorts).toEqual(oversizedSorts.slice(0, VIEW_SORTS_MAX));
    expect(parseViewLayoutSafe(oversizedLayout).sorts).toEqual(
      oversizedSorts.slice(0, VIEW_SORTS_MAX),
    );
  });

  test("an incoming layout over the cap is rejected by both schemas", () => {
    expect(() => parseViewLayout(oversizedLayout)).toThrow(
      `Invalid length: Expected <=${VIEW_SORTS_MAX} but received ${oversizedSorts.length}`,
    );
    expect(v.is(tViewLayoutSchema, oversizedLayout)).toBe(false);
    expect(
      v.is(tViewLayoutSchema, {
        ...oversizedLayout,
        sorts: oversizedSorts.slice(0, VIEW_SORTS_MAX),
      }),
    ).toBe(true);
  });
});

describe("view template property validation", () => {
  test("accepts saved AI properties with empty prompts", () => {
    expect(
      v.is(tViewTemplatePropertySchema, {
        version: 1,
        sourceId: "source_summary",
        name: "Summary",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "ai-model", prompt: "" },
        createIfMissing: true,
      }),
    ).toBe(true);
  });

  test("accepts explicit role absence", () => {
    expect(
      v.is(tViewTemplatePropertySchema, {
        version: 1,
        sourceId: "source_document_type",
        name: "Document Type",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "manual-input" },
        role: null,
        createIfMissing: true,
      }),
    ).toBe(true);
  });
});

// Property tests below assert that the two parallel schemas (the stored
// schema for internal parsing, the wire schema for the HTTP boundary) agree on
// every layout and filter shape. Drift between them lets payloads slip past the
// route validator and fail at parseViewLayout, or vice versa.

const arbPropertyId = fc.string({ minLength: 1, maxLength: 16 });
const arbHiddenProperties = fc.array(fc.string({ maxLength: 16 }), {
  maxLength: 5,
});

const arbBuiltinField = fc.constantFrom(...BUILTIN_FIELDS);
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

const arbCalculation = fc.record({
  propertyId: arbPropertyId,
  kind: fc.constantFrom(...CALCULATION_KINDS),
});

const baseLayoutFields = {
  version: fc.constant(1 as const),
  filters: fc.array(arbFilter, { maxLength: 4 }),
  sorts: fc.array(arbSort, { maxLength: 4 }),
  hiddenProperties: arbHiddenProperties,
  calculations: fc.array(arbCalculation, { maxLength: 3 }),
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
      subgroupByPropertyId: arbPropertyId,
    },
    {
      requiredKeys: [
        "type",
        "version",
        "filters",
        "sorts",
        "hiddenProperties",
        "calculations",
      ],
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
        "calculations",
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
        "calculations",
        "startDatePropertyId",
        "endDatePropertyId",
        "zoom",
        "showTable",
      ],
    },
  ),
  fc.record({
    type: fc.constant("avt" as const),
    ...baseLayoutFields,
    listId: fc.option(fc.uuid().map(brandPersistedLegalListId), {
      nil: null,
    }),
  }),
  fc.record({
    type: fc.constant("correspondence" as const),
    ...baseLayoutFields,
  }),
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
  "subgroupByPropertyId",
  "datePropertyId",
  "endDatePropertyId",
  "additionalDatePropertyIds",
  "mode",
  "startDatePropertyId",
  "zoom",
  "showTable",
  "listId",
]);

describe("conditionNodeSchema — properties", () => {
  test("the stored and wire schemas agree on every well-formed condition node", () => {
    assertProperty(
      "the stored and wire schemas agree on every well-formed condition node",
      fc.property(arbFilter, (filter) => {
        expect(v.is(conditionNodeSchema, filter)).toBe(true);
        expect(v.is(tConditionNode, filter)).toBe(true);
      }),
      {},
    );
  });
});

describe("viewLayoutSchema — properties", () => {
  test("the stored and wire schemas agree on every well-formed layout", () => {
    assertProperty(
      "the stored and wire schemas agree on every well-formed layout",
      fc.property(arbLayout, (layout) => {
        expect(v.is(viewLayoutSchema, layout)).toBe(true);
        expect(v.is(tViewLayoutSchema, layout)).toBe(true);
      }),
      {},
    );
  });

  test("parseViewLayout is identity on well-formed layouts", () => {
    assertProperty(
      "parseViewLayout is identity on well-formed layouts",
      fc.property(arbLayout, (layout) => {
        expect(parseViewLayout(layout)).toEqual(layout as ViewLayout);
      }),
      {},
    );
  });

  // Both contracts are closed: the stored schema and the wire schema refuse an
  // undeclared key, so a request carrying one never reaches its handler.
  test("an undeclared extra key is refused when stored and on the wire", () => {
    assertProperty(
      "an undeclared extra key is refused when stored and on the wire",
      fc.property(
        arbLayout,
        fc
          .string({ minLength: 1, maxLength: 16 })
          .filter((key) => !declaredLayoutKeys.has(key)),
        (layout, extraKey) => {
          const polluted = { ...layout, [extraKey]: "junk" };
          expect(v.is(viewLayoutSchema, polluted)).toBe(false);
          expect(v.is(tViewLayoutSchema, polluted)).toBe(false);
        },
      ),
      {},
    );
  });

  // Valibot before 1.5 found extra keys with `key in entries`, which walks the
  // prototype chain and let a key named like an Object.prototype member through.
  test("an Object.prototype-named extra key is refused when stored and on the wire", () => {
    const polluted = {
      type: "kanban" as const,
      version: 1 as const,
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      groupByPropertyId: "x",
      valueOf: "junk",
    };
    expect(v.is(viewLayoutSchema, polluted)).toBe(false);
    expect(v.is(tViewLayoutSchema, polluted)).toBe(false);
    const { valueOf: _extra, ...clean } = polluted;
    expect(v.is(viewLayoutSchema, clean)).toBe(true);
    expect(v.is(tViewLayoutSchema, clean)).toBe(true);
  });
});

describe("view calculations", () => {
  const kanbanLayout = {
    version: 1,
    type: "kanban",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
  } satisfies ViewLayout;

  test("a layout that omits calculations reads back as an empty list", () => {
    const { calculations: _omitted, ...withoutCalculations } = kanbanLayout;

    expect(parseViewLayout(withoutCalculations).calculations).toEqual([]);
  });

  test("a chosen calculation round-trips", () => {
    const layout = {
      ...kanbanLayout,
      calculations: [{ propertyId: "fee", kind: "sum" }],
    } satisfies ViewLayout;

    expect(parseViewLayout(layout).calculations).toEqual([
      { propertyId: "fee", kind: "sum" },
    ]);
    expect(v.is(tViewLayoutSchema, layout)).toBe(true);
  });

  test("kanban group and subgroup properties round-trip", () => {
    const layout = {
      ...kanbanLayout,
      groupByPropertyId: "status",
      subgroupByPropertyId: "assignee",
    } satisfies ViewLayout;

    expect(parseViewLayout(layout)).toMatchObject({
      groupByPropertyId: "status",
      subgroupByPropertyId: "assignee",
    });
    expect(v.is(tViewLayoutSchema, layout)).toBe(true);
  });

  test("a calculation the reducer does not implement is rejected", () => {
    expect(() =>
      parseViewLayout({
        ...kanbanLayout,
        calculations: [{ propertyId: "fee", kind: "geometric-mean" }],
      }),
    ).toThrow(v.ValiError);
  });
});
