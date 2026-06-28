import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { formatDate, renderComposite } from "./field-values";

const STYLES = ["long", "medium", "short", "iso"] as const;
const LOCALES = ["cs", "de", "pl", "en", "ar"] as const;

const pad = (value: number, length: number): string =>
  String(value).padStart(length, "0");

// Real calendar dates as YYYY-MM-DD (UTC), the strict input formatDate accepts.
const validIsoDate = fc
  .date({
    min: new Date("1900-01-01T00:00:00Z"),
    max: new Date("2200-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));

// Strings that match the YYYY-MM-DD shape but are not real dates (month or day
// out of range), so parseIsoDate must reject them.
const invalidIsoDate = fc
  .oneof(
    fc.tuple(
      fc.integer({ min: 0, max: 9999 }),
      fc.integer({ min: 13, max: 99 }),
      fc.integer({ min: 1, max: 99 }),
    ),
    fc.tuple(
      fc.integer({ min: 0, max: 9999 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 32, max: 99 }),
    ),
  )
  .map(
    ([year, month, day]) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
  );

describe("formatDate (properties)", () => {
  test("the 'iso' style returns a valid date unchanged", () => {
    fc.assert(
      fc.property(
        validIsoDate,
        fc.constantFrom(...LOCALES),
        (value, locale) => {
          expect(formatDate(value, { locale, style: "iso" })).toBe(value);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a localized style renders a valid date to a non-empty string", () => {
    const localizedStyle = fc.constantFrom("long", "medium", "short" as const);
    fc.assert(
      fc.property(
        validIsoDate,
        fc.constantFrom(...LOCALES),
        localizedStyle,
        (value, locale, style) => {
          const rendered = formatDate(value, { locale, style });
          expect(rendered).not.toBeNull();
          expect((rendered ?? "").length).toBeGreaterThan(0);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a non-existent calendar date is rejected for every style", () => {
    fc.assert(
      fc.property(
        invalidIsoDate,
        fc.constantFrom(...LOCALES),
        fc.constantFrom(...STYLES),
        (value, locale, style) => {
          expect(formatDate(value, { locale, style })).toBeNull();
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });
});

describe("renderComposite (properties)", () => {
  const partKey = fc.constantFrom("a", "b", "name", "date", "amount");
  const braceFree = fc
    .string()
    .filter((text) => !text.includes("{") && !text.includes("}"));

  test("substitutes a declared marker with its value", () => {
    fc.assert(
      fc.property(
        partKey,
        braceFree,
        braceFree,
        braceFree,
        (key, value, left, right) => {
          const format = `${left}{{${key}}}${right}`;
          expect(renderComposite([{ key }], format, { [key]: value })).toBe(
            `${left}${value}${right}`,
          );
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("leaves a marker for an undeclared part untouched", () => {
    fc.assert(
      fc.property(partKey, braceFree, (key, value) => {
        const format = `x {{${key}}} y`;
        expect(renderComposite([], format, { [key]: value })).toBe(format);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
