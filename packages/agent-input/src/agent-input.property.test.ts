/**
 * Properties over the classes of spelling each normalizer accepts.
 *
 * The example tables beside this file pin the spellings that have actually
 * been seen; these properties hold over the whole class, so a form nobody
 * wrote down yet cannot quietly read as a different value. Two invariants
 * apply to every kind: a spelling that carries one meaning round-trips to the
 * canonical value, and normalizing an already-canonical value is a fixed point
 * that reports no coercion.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";
import { foldToAscii } from "@stll/text-normalize";

import { normalizeBoolean } from "./boolean";
import { normalizeDateFormatSpec } from "./date-format-spec";
import { normalizeDateValue } from "./date-value";
import { normalizeEnumValue } from "./enum-value";
import { normalizeLocale } from "./locale";
import type { Normalized } from "./normalized";
import { normalizeNumber } from "./number";

setDefaultTimeout(propertyTestTimeout(20_000));

// A locale whose date is day-first with a month name (`de`, `cs`), one that
// writes the month name into a phrase (`pt-BR`, `es`), and one that is
// year-first (`hu`): three orderings no single word order covers.
const READING_LOCALES = [
  "en",
  "cs",
  "pl",
  "de",
  "en-GB",
  "pt-BR",
  "es",
  "hu",
] as const;

const valueOrNull = <TValue>(result: Normalized<TValue>): TValue | null =>
  result.ok ? result.value : null;

const pad = (value: number): string => String(value).padStart(2, "0");

/** A real calendar date, as its ISO spelling plus its components. */
const isoDateArb = fc
  .date({
    min: new Date(Date.UTC(2000, 0, 1)),
    max: new Date(Date.UTC(2099, 11, 31)),
    noInvalidDate: true,
  })
  .map((date) => ({
    iso: date.toISOString().slice(0, 10),
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }));

/** The whole date as one locale renders it, in its own ordering and with its
 *  own literals — what a model copies back out of the document. */
const rendered = (
  year: number,
  month: number,
  day: number,
  locale: string,
  style: "long" | "short",
): string =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: style,
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));

describe("date values", () => {
  test("every unambiguous numeric spelling round-trips to the ISO date", () => {
    fc.assert(
      fc.property(isoDateArb, ({ iso, year, month, day }) => {
        const spellings = [
          iso,
          `${year}-${month}-${day}`,
          `${year}.${pad(month)}.${pad(day)}`,
          `${year}/${pad(month)}/${pad(day)}`,
          `${pad(day)}.${pad(month)}.${year}`,
          `${day}. ${month}. ${year}`,
          `${iso}T12:00:00Z`,
          // A slashed date is only unambiguous when the day cannot be a month.
          ...(day > 12 ? [`${day}/${month}/${year}`] : []),
        ];
        for (const spelling of spellings) {
          expect(valueOrNull(normalizeDateValue(spelling))).toBe(iso);
        }
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a date round-trips as every locale the field may render in writes it", () => {
    fc.assert(
      fc.property(
        isoDateArb,
        fc.constantFrom(...READING_LOCALES),
        fc.constantFrom("long", "short" as const),
        ({ iso, year, month, day }, locale, style) => {
          const options = { locales: [locale] };
          expect(
            valueOrNull(
              normalizeDateValue(
                rendered(year, month, day, locale, style),
                options,
              ),
            ),
          ).toBe(iso);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a day/month pair that reads two ways is always asked about", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 2000, max: 2099 }),
        (first, second, year) => {
          const result = normalizeDateValue(
            `${pad(first)}/${pad(second)}/${year}`,
          );
          // Both readings land on the same day when the components agree.
          if (first === second) {
            expect(valueOrNull(result)).toBe(
              `${year}-${pad(first)}-${pad(second)}`,
            );
            return;
          }
          expect(result.ok).toBe(false);
          expect(!result.ok && result.hint).toContain(
            `${year}-${pad(second)}-${pad(first)}`,
          );
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a two-digit year is never read as a date", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 99 }),
        (day, month, year) => {
          expect(
            normalizeDateValue(`${pad(day)}-${pad(month)}-${pad(year)}`).ok,
          ).toBe(false);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("reading an ISO date again is a fixed point with nothing to report", () => {
    fc.assert(
      fc.property(isoDateArb, ({ iso }) => {
        const first = normalizeDateValue(iso);
        expect(first.ok && first.value).toBe(iso);
        expect(first.ok && first.note).toBeUndefined();
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("numbers", () => {
  const NUMBER_LOCALES = ["en-US", "en-GB", "cs", "de", "pl", "fr"] as const;

  test("a number formatted in a locale reads back as that number", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -99_999_999, max: 99_999_999 }),
        fc.integer({ min: 0, max: 2 }),
        fc.constantFrom(...NUMBER_LOCALES),
        (whole, decimals, locale) => {
          const value = Number((whole / 10 ** decimals).toFixed(decimals));
          const formatted = new Intl.NumberFormat(locale, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }).format(value);
          expect(valueOrNull(normalizeNumber(formatted, { locale }))).toBe(
            value,
          );
        },
      ),
      propertyConfig({ numRuns: 400 }),
    );
  });

  test("a plain JSON number spelled as a string reads back unchanged", () => {
    fc.assert(
      fc.property(
        fc.double({
          min: -1e9,
          max: 1e9,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        (value) => {
          // Negative zero has no spelling of its own ("0"), so the round trip
          // through a string is 0 by arithmetic, not by a reading choice.
          fc.pre(!Object.is(value, -0));
          expect(valueOrNull(normalizeNumber(value))).toBe(value);
          const spelled = String(value);
          // `String` may emit exponent notation, which is read as well.
          expect(valueOrNull(normalizeNumber(spelled))).toBe(value);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("no spelling reads as a number a field cannot carry", () => {
    const exponentialArb = fc
      .tuple(
        fc.integer({ min: -9999, max: 9999 }),
        fc.integer({ min: -9999, max: 9999 }),
      )
      .map(([mantissa, exponent]) => `${mantissa}e${exponent}`);
    fc.assert(
      fc.property(fc.oneof(exponentialArb, fc.string()), (spelling) => {
        const read = normalizeNumber(spelling);
        expect(!read.ok || Number.isFinite(read.value)).toBe(true);
      }),
      propertyConfig({ numRuns: 400 }),
    );
  });

  test("currency and grouping around the digits never change the value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.constantFrom("EUR", "USD", "Kč", "zł", "£", "€"),
        (value, currency) => {
          for (const spelling of [
            `${currency} ${value}`,
            `${value} ${currency}`,
            `${value}.-`,
          ]) {
            expect(valueOrNull(normalizeNumber(spelling))).toBe(value);
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

/** Case, surrounding whitespace, and the diacritics a keyboard drops are the
 *  mangling every closed-vocabulary reader has to survive. */
const manglings = (value: string): readonly string[] => [
  value,
  value.toUpperCase(),
  value.toLowerCase(),
  ` ${value} `,
  `\n${value}\t`,
];

describe("booleans", () => {
  const TRUE_WORDS = [
    "true",
    "yes",
    "y",
    "1",
    "on",
    "ano",
    "tak",
    "ja",
    "checked",
  ] as const;
  const FALSE_WORDS = [
    "false",
    "no",
    "n",
    "0",
    "off",
    "ne",
    "nie",
    "nein",
    "unchecked",
  ] as const;

  test("every accepted word reads the same however it is cased or spaced", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRUE_WORDS, ...FALSE_WORDS),
        (word: string) => {
          const expected = TRUE_WORDS.some((candidate) => candidate === word);
          for (const spelling of manglings(word)) {
            expect(valueOrNull(normalizeBoolean(spelling))).toBe(expected);
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a word outside the set is asked about rather than read as truthy", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), (candidate) => {
        // The reader folds diacritics, so the precondition has to fold too:
        // a generated "Áno" IS one of the accepted words.
        const known = [...TRUE_WORDS, ...FALSE_WORDS].some(
          (word) => word === foldToAscii(candidate.trim()).toLowerCase(),
        );
        fc.pre(!known);
        expect(normalizeBoolean(candidate).ok).toBe(false);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});

describe("locales and date format specs", () => {
  test("a tag round-trips through every spelling of the same tag", () => {
    fc.assert(
      fc.property(fc.constantFrom(...READING_LOCALES), (tag: string) => {
        for (const spelling of [
          tag,
          tag.toLowerCase(),
          tag.toUpperCase(),
          tag.replaceAll("-", "_"),
          ` ${tag} `,
        ]) {
          expect(valueOrNull(normalizeLocale(spelling))).toBe(
            valueOrNull(normalizeLocale(tag)),
          );
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a bare style is read only when its output carries no locale", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("long", "medium", "short", "iso", "full", "numeric"),
        fc.constantFrom("", " ", "  "),
        (style: string, spaces: string) => {
          const result = normalizeDateFormatSpec(`${spaces}${style}${spaces}`);
          // "iso" renders the same string in every language, so it needs no
          // locale; every other style without one would guess the language.
          expect(result.ok).toBe(style === "iso");
          expect(result.ok && result.value).toEqual(
            style === "iso" ? { locale: "en", style: "iso" } : false,
          );
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("a spec round-trips through its canonical spelling", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...READING_LOCALES),
        fc.constantFrom("long", "medium", "short", "iso"),
        (locale, style) => {
          const first = normalizeDateFormatSpec(`${locale}-${style}`);
          expect(first.ok && first.value.style).toBe(style);
          const again = normalizeDateFormatSpec(
            first.ok ? first.value : "unreachable",
          );
          expect(again.ok && again.value).toEqual(
            first.ok ? first.value : { locale: "", style: "long" },
          );
          expect(again.ok && again.note).toBeUndefined();
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("closed vocabularies", () => {
  const allowedArb = fc.uniqueArray(
    fc.stringMatching(/^[a-z]{3,10}$/u).filter((value) => value.length >= 3),
    { minLength: 2, maxLength: 6 },
  );

  test("an allowed value is read however it is cased or spaced", () => {
    fc.assert(
      fc.property(allowedArb, fc.nat(), (allowed, index) => {
        const value = allowed[index % allowed.length] ?? "";
        for (const spelling of manglings(value)) {
          expect(valueOrNull(normalizeEnumValue(spelling, allowed))).toBe(
            value,
          );
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a value the set does not carry is never read as a member", () => {
    fc.assert(
      fc.property(
        allowedArb,
        fc.string({ minLength: 1, maxLength: 12 }),
        (allowed, candidate) => {
          const isMember = allowed.some(
            (value) =>
              foldToAscii(value).toLowerCase() ===
              foldToAscii(candidate.trim()).toLowerCase(),
          );
          fc.pre(!isMember);
          expect(normalizeEnumValue(candidate, allowed).ok).toBe(false);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
