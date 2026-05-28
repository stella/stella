import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  parseViewLayout,
  tViewFilterConditionSchema,
  tViewLayoutSchema,
  tViewTemplatePropertySchema,
  viewFilterConditionSchema,
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

const arbId = fc.string({ minLength: 1, maxLength: 16 });
const arbPropertyId = fc.string({ minLength: 1, maxLength: 16 });
const arbHiddenProperties = fc.array(fc.string({ maxLength: 16 }), {
  maxLength: 5,
});

const arbEntityKind = fc.constantFrom(
  "document",
  "folder",
  "task",
  "message",
  "link",
);
const arbBuiltinField = fc.constantFrom("status", "priority");
const arbStringOrArray = fc.oneof(
  fc.string({ maxLength: 16 }),
  fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
);

const arbFilter = fc.oneof(
  fc.record({
    id: arbId,
    field: fc.constant("kind" as const),
    op: fc.constant("in" as const),
    value: fc.array(arbEntityKind, { maxLength: 5 }),
  }),
  fc.record({
    id: arbId,
    field: fc.constant("property" as const),
    propertyId: arbPropertyId,
    op: fc.constantFrom("eq", "neq", "contains", "is_empty"),
    value: arbStringOrArray,
  }),
  fc.record({
    id: arbId,
    field: fc.constant("builtin" as const),
    builtinField: arbBuiltinField,
    op: fc.constantFrom("eq", "neq", "in", "is_empty"),
    value: arbStringOrArray,
  }),
);

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
  fc.record({
    type: fc.constant("kanban" as const),
    ...baseLayoutFields,
    groupByPropertyId: arbPropertyId,
  }),
  fc.record({
    type: fc.constant("calendar" as const),
    ...baseLayoutFields,
    datePropertyId: arbPropertyId,
    endDatePropertyId: arbPropertyId,
    additionalDatePropertyIds: fc.array(arbPropertyId, { maxLength: 3 }),
    mode: fc.constantFrom("month", "week", "year"),
  }),
  fc.record({
    type: fc.constant("timeline" as const),
    ...baseLayoutFields,
    startDatePropertyId: arbPropertyId,
    endDatePropertyId: arbPropertyId,
    zoom: fc.constantFrom("day", "week", "month", "quarter"),
    groupByPropertyId: arbPropertyId,
    showTable: fc.boolean(),
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

describe("viewFilterConditionSchema — properties", () => {
  test("Valibot and TypeBox agree on every well-formed filter", () => {
    fc.assert(
      fc.property(arbFilter, (filter) => {
        expect(v.is(viewFilterConditionSchema, filter)).toBe(true);
        expect(Value.Check(tViewFilterConditionSchema, filter)).toBe(true);
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
