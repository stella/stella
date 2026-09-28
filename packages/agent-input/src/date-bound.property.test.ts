import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import { parsePlainDate } from "@stll/time";

import { normalizeDateBound } from "./date-value";

const pad = (value: number): string => String(value).padStart(2, "0");

const boundArb = fc.constantFrom("start", "end" as const);
const yearArb = fc.integer({ min: 1000, max: 8999 });
const monthArb = fc.integer({ min: 1, max: 12 });

const valueOf = (
  result: ReturnType<typeof normalizeDateBound>,
): string | null => (result.ok === true ? result.value : null);

describe("date range bounds", () => {
  test("a bare year reads as its first day from, and its last day to", () => {
    fc.assert(
      fc.property(yearArb, boundArb, (year, bound) => {
        expect(valueOf(normalizeDateBound(String(year), { bound }))).toBe(
          bound === "start" ? `${year}-01-01` : `${year}-12-31`,
        );
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a year and month read as the month's first or last real day", () => {
    fc.assert(
      fc.property(
        yearArb,
        monthArb,
        fc.constantFrom(
          (year: number, month: number) => `${year}-${pad(month)}`,
          (year: number, month: number) => `${pad(month)}/${year}`,
          (year: number, month: number) => `${month}/${year}`,
        ),
        (year, month, spell) => {
          const start = valueOf(
            normalizeDateBound(spell(year, month), { bound: "start" }),
          );
          const end = valueOf(
            normalizeDateBound(spell(year, month), { bound: "end" }),
          );
          expect(start).toBe(`${year}-${pad(month)}-01`);
          const last = end === null ? null : parsePlainDate(end);
          expect(last?.year).toBe(year);
          expect(last?.month).toBe(month);
          // The last day is the last one: the next day is another month.
          expect(last?.add({ days: 1 }).month).not.toBe(month);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a date in a sentinel year is no bound", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 999 }),
          fc.integer({ min: 9000, max: 9999 }),
        ),
        monthArb,
        fc.integer({ min: 1, max: 28 }),
        boundArb,
        (year, month, day, bound) => {
          const iso = `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
          expect(normalizeDateBound(iso, { bound }).ok).toBe("absent");
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("an ISO date passes through unchanged with nothing to report", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date(Date.UTC(1000, 0, 1)),
          max: new Date(Date.UTC(8999, 11, 31)),
          noInvalidDate: true,
        }),
        boundArb,
        (date, bound) => {
          const iso = date.toISOString().slice(0, 10);
          expect(normalizeDateBound(iso, { bound })).toEqual({
            ok: true,
            value: iso,
          });
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
