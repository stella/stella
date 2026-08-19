import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { CalculationKind } from "@stll/calculations";
import { CALCULATION_KINDS } from "@stll/calculations";
import { propertyConfig } from "@stll/property-testing";

import type { CalculationSelection } from "./calculation-selection";
import { applyCalculationSelection } from "./calculation-selection";

const selection = (
  propertyId: string,
  kind: CalculationKind = "sum",
): CalculationSelection => ({ propertyId, kind });

describe("applyCalculationSelection", () => {
  test("a property that already has one keeps its place when the reduction changes", () => {
    const selections = [selection("fee"), selection("hours"), selection("tax")];

    expect(
      applyCalculationSelection({
        selections,
        propertyId: "fee",
        kind: "average",
      }),
    ).toEqual([
      selection("fee", "average"),
      selection("hours"),
      selection("tax"),
    ]);
  });

  test("a property that has none is appended", () => {
    expect(
      applyCalculationSelection({
        selections: [selection("fee")],
        propertyId: "hours",
        kind: "max",
      }),
    ).toEqual([selection("fee"), selection("hours", "max")]);
  });

  test("choosing none removes it and leaves the rest in order", () => {
    expect(
      applyCalculationSelection({
        selections: [selection("fee"), selection("hours"), selection("tax")],
        propertyId: "hours",
        kind: null,
      }),
    ).toEqual([selection("fee"), selection("tax")]);
  });
});

const idArb = fc.constantFrom("a", "b", "c", "d");
const selectionsArb: fc.Arbitrary<CalculationSelection[]> = fc
  .uniqueArray(idArb, { maxLength: 4 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc
          .constantFrom(...CALCULATION_KINDS)
          .map((kind) => selection(id, kind)),
      ),
    ),
  )
  .map((entries) => entries.slice());

describe("selection order invariants", () => {
  test("changing a reduction never reorders the row", () => {
    fc.assert(
      fc.property(
        selectionsArb,
        idArb,
        fc.constantFrom(...CALCULATION_KINDS),
        (selections, propertyId, kind) => {
          const next = applyCalculationSelection({
            selections,
            propertyId,
            kind,
          });
          const wasShown = selections.some(
            (candidate) => candidate.propertyId === propertyId,
          );

          if (wasShown) {
            expect(next.map((entry) => entry.propertyId)).toEqual(
              selections.map((entry) => entry.propertyId),
            );
          } else {
            expect(next.map((entry) => entry.propertyId)).toEqual([
              ...selections.map((entry) => entry.propertyId),
              propertyId,
            ]);
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a property appears at most once, whatever is chosen", () => {
    fc.assert(
      fc.property(
        selectionsArb,
        idArb,
        fc.option(fc.constantFrom(...CALCULATION_KINDS), { nil: null }),
        (selections, propertyId, kind) => {
          const next = applyCalculationSelection({
            selections,
            propertyId,
            kind,
          });
          const ids = next.map((entry) => entry.propertyId);

          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("removing then re-choosing puts it back at the end, and only then", () => {
    const selections = [selection("fee"), selection("hours")];
    const removed = applyCalculationSelection({
      selections,
      propertyId: "fee",
      kind: null,
    });

    expect(
      applyCalculationSelection({
        selections: removed,
        propertyId: "fee",
        kind: "sum",
      }).map((entry) => entry.propertyId),
    ).toEqual(["hours", "fee"]);
  });
});
