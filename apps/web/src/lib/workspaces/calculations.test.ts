import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { runCalculation } from "@stll/calculations";
import { cents } from "@stll/money";
import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceField, WorkspaceFieldContent } from "@/lib/types";
import {
  calculationKindsForProperty,
  propertyAppliesToKinds,
  toCalculationValue,
} from "@/lib/workspaces/calculations";

const field = (content: WorkspaceFieldContent): WorkspaceField => ({
  entityId: toSafeId<"entity">("entity-1"),
  id: toSafeId<"field">("field-1"),
  propertyId: toSafeId<"property">("property-1"),
  content,
});

describe("toCalculationValue", () => {
  test("a missing field is empty, not zero", () => {
    expect(toCalculationValue(undefined)).toEqual({ type: "empty" });
  });

  test("a blank text field is empty, so it does not count as filled", () => {
    expect(
      toCalculationValue(field({ version: 1, type: "text", value: "  " })),
    ).toEqual({ type: "empty" });
  });

  test("an int with no currency reduces as a number", () => {
    expect(
      toCalculationValue(
        field({ version: 1, type: "int", value: 42, currency: null }),
      ),
    ).toEqual({ type: "number", value: 42 });
  });

  test("an int with a currency reduces as money, scaled to minor units", () => {
    expect(
      toCalculationValue(
        field({ version: 1, type: "int", value: 1500, currency: "CZK" }),
      ),
    ).toEqual({ type: "money", amountCents: cents(150_000), currency: "CZK" });
  });

  test("a currency with no minor unit is not multiplied", () => {
    expect(
      toCalculationValue(
        field({ version: 1, type: "int", value: 1500, currency: "JPY" }),
      ),
    ).toEqual({ type: "money", amountCents: cents(1500), currency: "JPY" });
  });

  test("an unset select is empty", () => {
    expect(
      toCalculationValue(
        field({ version: 1, type: "single-select", value: null }),
      ),
    ).toEqual({ type: "empty" });
  });
});

describe("summing an int column that carries currencies", () => {
  const moneyField = (value: number, currency: string) =>
    field({ version: 1, type: "int", value, currency });

  test("one currency totals into that currency", () => {
    const result = runCalculation({
      kind: "sum",
      values: [moneyField(10, "EUR"), moneyField(5, "EUR")].map(
        toCalculationValue,
      ),
    });

    expect(result).toEqual({
      type: "money",
      kind: "sum",
      totals: [{ currency: "EUR", amountCents: cents(1500) }],
    });
  });

  test("two currencies stay two lines rather than one wrong number", () => {
    const result = runCalculation({
      kind: "sum",
      values: [moneyField(10, "EUR"), moneyField(100, "CZK")].map(
        toCalculationValue,
      ),
    });

    expect(result).toEqual({
      type: "money",
      kind: "sum",
      totals: [
        { currency: "CZK", amountCents: cents(10_000) },
        { currency: "EUR", amountCents: cents(1000) },
      ],
    });
  });
});

describe("calculationKindsForProperty", () => {
  const property = (contentType: "int" | "text") => ({
    id: toSafeId<"property">("p"),
    name: "p",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    workspaceId: toSafeId<"workspace">("w"),
    status: "fresh" as const,
    content:
      contentType === "int"
        ? ({ version: 1, type: "int", value: 0, currency: null } as const)
        : ({ version: 1, type: "text", value: "" } as const),
    tool: { version: 1, type: "manual-input" } as const,
    kinds: null,
  });

  test("only a numeric property offers a sum", () => {
    expect(calculationKindsForProperty(property("int"))).toContain("sum");
    expect(calculationKindsForProperty(property("text"))).not.toContain("sum");
  });

  test("every property can be counted", () => {
    expect(calculationKindsForProperty(property("text"))).toContain("count");
  });

  test("a share of the view is not offered while nothing supplies the whole", () => {
    expect(calculationKindsForProperty(property("int"))).not.toContain(
      "percent-of-total",
    );
  });
});

describe("propertyAppliesToKinds", () => {
  // The defect this guards: a board of tasks offered totals over properties
  // only documents carry, because the picker never asked which kinds a
  // property applies to.
  test("a document-only property is not offered on a task view", () => {
    expect(propertyAppliesToKinds({ kinds: ["document"] }, ["task"])).toBe(
      false,
    );
  });

  test("a property shared by one of the view's kinds is offered", () => {
    expect(
      propertyAppliesToKinds({ kinds: ["document", "task"] }, ["task"]),
    ).toBe(true);
  });

  test("an unscoped property applies everywhere", () => {
    expect(propertyAppliesToKinds({ kinds: null }, ["task"])).toBe(true);
  });

  test("an unrestricted view offers every property", () => {
    expect(propertyAppliesToKinds({ kinds: ["document"] }, null)).toBe(true);
  });
});

describe("a column's calculation reads exactly the column's cards", () => {
  const intField = (value: number) =>
    field({ version: 1, type: "int", value, currency: null });

  test("summing the cards in each column equals summing the board", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.integer({ min: -500, max: 500 }), { maxLength: 8 }),
          { maxLength: 5 },
        ),
        (columns) => {
          const sumOf = (values: number[]) => {
            const result = runCalculation({
              kind: "sum",
              values: values.map((value) =>
                toCalculationValue(intField(value)),
              ),
            });
            return result.type === "number" ? result.value : Number.NaN;
          };

          // The oracle is a plain addition, not another call through the
          // reducer: a regression that mapped every value to zero, or read
          // "sum" as some other associative fold, would satisfy both sides of
          // a reducer-versus-reducer comparison.
          const rows = columns.flat();
          const expected = rows.reduce((total, value) => total + value, 0);

          expect(sumOf(rows)).toBe(expected);
          expect(
            columns.reduce((total, column) => total + sumOf(column), 0),
          ).toBe(expected);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
