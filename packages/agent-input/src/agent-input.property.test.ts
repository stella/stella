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

import { COUNTRY_ALPHA3_BY_CODE, COUNTRY_CODES } from "@stll/country-codes";
import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";
import { foldToAscii } from "@stll/text-normalize";

import { normalizeBoolean } from "./boolean";
import { normalizeCountry } from "./country";
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

describe("countries", () => {
  /** Every country the reader can name, by its alpha-2 key. */
  const countryArb = fc.constantFrom(...COUNTRY_CODES);

  /** The languages the reader indexes names in. */
  const nameLocaleArb = fc.constantFrom("en", "cs", "sk", "pl", "de");

  const displayName = (region: string, locale: string): string | undefined =>
    new Intl.DisplayNames([locale], {
      type: "region",
      style: "long",
      fallback: "none",
    }).of(region);

  test("both ISO codes of a country read as the same country", () => {
    fc.assert(
      fc.property(countryArb, (alpha2) => {
        const alpha3 = COUNTRY_ALPHA3_BY_CODE[alpha2];
        const fromAlpha2 = normalizeCountry(alpha2);
        const fromAlpha3 = normalizeCountry(alpha3);
        expect(fromAlpha2.ok && fromAlpha2.value).toEqual({ alpha3, alpha2 });
        expect(fromAlpha3.ok && fromAlpha3.value).toEqual({ alpha3, alpha2 });
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  // A code is unconditional: every case and padding of it must read, and read
  // as its own country. A name is not, because a name can in principle be
  // ambiguous, so it is held to the weaker claim that it is never read as some
  // other country. Asserting both under one conditional would let the codes go
  // unchecked.
  test("every case and padding of a country's codes reads as that country", () => {
    fc.assert(
      fc.property(
        countryArb,
        fc.constantFrom("", " ", "  ", "\t", "\n"),
        (alpha2, spaces) => {
          const alpha3 = COUNTRY_ALPHA3_BY_CODE[alpha2];
          const expected = { alpha3, alpha2 };
          for (const spelling of [
            alpha2,
            alpha2.toLowerCase(),
            alpha3,
            alpha3.toLowerCase(),
            `${spaces}${alpha2}${spaces}`,
            `${spaces}${alpha3}${spaces}`,
            `${spaces}${alpha3.toLowerCase()}${spaces}`,
          ]) {
            const read = normalizeCountry(spelling);
            expect(read.ok && read.value).toEqual(expected);
          }
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a country's name is never read as a different country", () => {
    fc.assert(
      fc.property(countryArb, nameLocaleArb, (alpha2, locale) => {
        const name = displayName(alpha2, locale);
        fc.pre(name !== undefined);
        for (const spelling of [
          name,
          name.toUpperCase(),
          name.toLowerCase(),
          foldToAscii(name),
          ` ${name} `,
        ]) {
          const read = normalizeCountry(spelling);
          if (read.ok) {
            expect(read.value.alpha2).toBe(alpha2);
            continue;
          }
          // The only permitted refusal names the readings it could not decide
          // between.
          expect(read.hint).toContain("more than one country");
        }
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a canonical code is a fixed point that reports no coercion", () => {
    fc.assert(
      fc.property(countryArb, (alpha2) => {
        const read = normalizeCountry(COUNTRY_ALPHA3_BY_CODE[alpha2]);
        expect(read.ok && read.note).toBeUndefined();
        // An alpha-2 caller's canonical spelling is its own, so that is the
        // fixed point there.
        const asAlpha2 = normalizeCountry(alpha2, { spelling: "alpha-2" });
        expect(asAlpha2.ok && asAlpha2.note).toBeUndefined();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a country's name in any read language names that country", () => {
    fc.assert(
      fc.property(countryArb, nameLocaleArb, (alpha2, locale) => {
        const name = displayName(alpha2, locale);
        fc.pre(name !== undefined);
        const read = normalizeCountry(name);
        if (read.ok) {
          expect(read.value.alpha2).toBe(alpha2);
          return;
        }
        // The only permitted refusal is an ambiguity that names its readings.
        expect(read.hint).toContain("more than one country");
      }),
      propertyConfig({ numRuns: 400 }),
    );
  });

  test("an absent value asks and never resolves to a country", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, null, "", " ", "   ", "\t\n"),
        (absent) => {
          const read = normalizeCountry(absent, { tool: "a_tool" });
          if (read.ok) {
            throw new Error(
              `an absent country resolved to ${read.value.alpha3}`,
            );
          }
          expect(read.hint).toContain("is required");
        },
      ),
      propertyConfig({ numRuns: 50 }),
    );
  });

  // Reading is idempotent over the spellings the reader accepts: the code it
  // returns is itself a spelling, so a caller that stores and re-reads a value
  // cannot walk it to a different country. Drawn from real spellings rather
  // than from random strings, which the reader rejects almost always and which
  // would make this a test of the generator's skip tolerance.
  test("reading a country the reader accepted again returns the same country", () => {
    const spellingArb = fc
      .tuple(countryArb, nameLocaleArb, fc.integer({ min: 0, max: 3 }))
      .map(([alpha2, locale, form]) => {
        const name = displayName(alpha2, locale);
        switch (form) {
          case 0:
            return alpha2;
          case 1:
            return COUNTRY_ALPHA3_BY_CODE[alpha2];
          case 2:
            return alpha2.toLowerCase();
          default:
            return name ?? alpha2;
        }
      });
    fc.assert(
      fc.property(spellingArb, (spelling) => {
        const read = normalizeCountry(spelling);
        fc.pre(read.ok);
        const again = normalizeCountry(read.value.alpha3);
        expect(again.ok && again.value).toEqual(read.value);
        const asAlpha2 = normalizeCountry(read.value.alpha2, {
          spelling: "alpha-2",
        });
        expect(asAlpha2.ok && asAlpha2.value).toEqual(read.value);
      }),
      propertyConfig({ numRuns: 400 }),
    );
  });

  test("a value that names no country is never read as one", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "Atlantis",
          "ZZ",
          "ZZZ",
          "nowhere",
          "123",
          "C",
          "country",
          "the moon",
        ),
        (candidate) => {
          expect(normalizeCountry(candidate).ok).toBe(false);
        },
      ),
      propertyConfig({ numRuns: 50 }),
    );
  });

  test("a non-string is always asked about", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.array(fc.string())),
        (candidate) => {
          expect(normalizeCountry(candidate).ok).toBe(false);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
