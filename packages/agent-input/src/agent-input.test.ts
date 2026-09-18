import { describe, expect, test } from "bun:test";

import { normalizeBoolean } from "./boolean";
import { normalizeCountry } from "./country";
import { normalizeDateFormatSpec } from "./date-format-spec";
import type { DateFormatSpec } from "./date-format-spec";
import { normalizeDateValue } from "./date-value";
import { normalizeEnumValue } from "./enum-value";
import { isPlausibleLocale, normalizeLocale } from "./locale";
import type { Normalized } from "./normalized";
import { normalizeNumber } from "./number";
import type { AgentInputNormalizationAnnotation } from "./schema";
import {
  AGENT_INPUT_NORMALIZATION_KEY,
  AGENT_INPUT_NORMALIZATION_KIND,
  agentInputNormalization,
  normalizeAgentInput,
} from "./schema";

/** The value, or the ask rendered so a failure names what the agent sent. */
const valueOf = <TValue>(result: Normalized<TValue>): TValue | string =>
  result.ok ? result.value : `ask: ${result.received} (${result.hint})`;

describe("date values", () => {
  test.each([
    ["2026-10-01", "2026-10-01"],
    ["2026-10-1", "2026-10-01"],
    [" 2026-10-01 ", "2026-10-01"],
    ["2026-10-01T09:30:00Z", "2026-10-01"],
    ["01.10.2026", "2026-10-01"],
    ["1. 10. 2026", "2026-10-01"],
    ["1.10.2026", "2026-10-01"],
    ["2026.10.01", "2026-10-01"],
    ["2026/10/01", "2026-10-01"],
    ["October 1, 2026", "2026-10-01"],
    ["1 October 2026", "2026-10-01"],
    ["1st October 2026", "2026-10-01"],
    ["Oct 1, 2026", "2026-10-01"],
    // Only one reading survives when a component cannot be a month.
    ["13/10/2026", "2026-10-13"],
    ["10/13/2026", "2026-10-13"],
  ])("reads %s as %s", (input, iso) => {
    expect(valueOf(normalizeDateValue(input))).toBe(iso);
  });

  test("reads a month name in the locale the field renders in", () => {
    expect(
      valueOf(normalizeDateValue("1. října 2026", { locales: ["cs"] })),
    ).toBe("2026-10-01");
    expect(
      valueOf(normalizeDateValue("1 października 2026", { locales: ["pl"] })),
    ).toBe("2026-10-01");
  });

  test("reads the structure the locale renders, not only its month name", () => {
    expect(
      valueOf(normalizeDateValue("1 de octubre de 2026", { locales: ["es"] })),
    ).toBe("2026-10-01");
    expect(
      valueOf(normalizeDateValue("2026. október 1.", { locales: ["hu"] })),
    ).toBe("2026-10-01");
    expect(
      valueOf(normalizeDateValue("2026年10月1日", { locales: ["ja"] })),
    ).toBe("2026-10-01");
  });

  test("a locale never decides a day/month pair separated by slashes", () => {
    expect(normalizeDateValue("01/02/2026", { locales: ["en-GB"] }).ok).toBe(
      false,
    );
    expect(normalizeDateValue("01/02/2026", { locales: ["en-US"] }).ok).toBe(
      false,
    );
  });

  test("a month name in a locale the field does not render in is an ask", () => {
    const result = normalizeDateValue("1. října 2026");
    expect(result.ok).toBe(false);
  });

  test("notes the spelling it read, and says nothing when it was canonical", () => {
    const read = normalizeDateValue("1. 10. 2026");
    expect(read.ok && read.note).toBe('Read "1. 10. 2026" as "2026-10-01".');
    const canonical = normalizeDateValue("2026-10-01");
    expect(canonical.ok && canonical.note).toBeUndefined();
  });

  test("names both readings of a day/month pair instead of guessing", () => {
    const result = normalizeDateValue("01/02/2026");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.hint).toBe(
      'That reads as 2026-02-01 with the day first, or 2026-01-02 with the month first. Send "2026-02-01" or "2026-01-02".',
    );
  });

  test.each([
    "02-03-26",
    "2026-02-30",
    "31.02.2026",
    "13/13/2026",
    "not a date",
    "",
  ])("asks about %s", (input) => {
    expect(normalizeDateValue(input).ok).toBe(false);
  });

  test("a non-string is an ask, not a coercion", () => {
    expect(normalizeDateValue(20_261_001).ok).toBe(false);
    expect(normalizeDateValue(null).ok).toBe(false);
  });
});

describe("date format specs", () => {
  test.each([
    ["pl-long", { locale: "pl", style: "long" }],
    ["cs", { locale: "cs", style: "long" }],
    ["en-GB", { locale: "en-GB", style: "long" }],
    ["en-GB-short", { locale: "en-GB", style: "short" }],
    ["cs_CZ", { locale: "cs-CZ", style: "long" }],
    ["cs_CZ-long", { locale: "cs-CZ", style: "long" }],
    ["pt-br-short", { locale: "pt-BR", style: "short" }],
    // Style synonyms: each names exactly one of the catalogue's styles.
    ["pl-full", { locale: "pl", style: "long" }],
    ["de-numeric", { locale: "de", style: "short" }],
  ] as const satisfies readonly (readonly [string, DateFormatSpec])[])(
    "reads %s",
    (spec, expected) => {
      expect(valueOf(normalizeDateFormatSpec(spec))).toEqual(expected);
    },
  );

  test.each([
    [
      { locale: "cs", style: "medium" },
      { locale: "cs", style: "medium" },
    ],
    [
      { Locale: "cs_CZ", Style: "SHORT" },
      { locale: "cs-CZ", style: "short" },
    ],
    [{ locale: "pl" }, { locale: "pl", style: "long" }],
  ] as const satisfies readonly (readonly [unknown, DateFormatSpec])[])(
    "reads the wire object %p",
    (spec, expected) => {
      expect(valueOf(normalizeDateFormatSpec(spec))).toEqual(expected);
    },
  );

  test("a bare style names no locale, so it is an ask", () => {
    // The style test runs first: "long" is not a language tag, and reading it
    // as one would silently render dates in an unknown language.
    for (const spec of ["long", "medium", "short", "full", "numeric"]) {
      expect(normalizeDateFormatSpec(spec).ok).toBe(false);
    }
  });

  test('"iso" alone is a whole format: its output has no locale', () => {
    expect(valueOf(normalizeDateFormatSpec("iso"))).toEqual({
      locale: "en",
      style: "iso",
    });
    expect(valueOf(normalizeDateFormatSpec(" ISO "))).toEqual({
      locale: "en",
      style: "iso",
    });
  });

  test.each([
    "",
    "not a locale at all",
    "cs-CZ!",
    { locale: "cs", style: "long", extra: true },
    { style: "long" },
    42,
    null,
  ])("asks about %p", (spec) => {
    expect(normalizeDateFormatSpec(spec).ok).toBe(false);
  });

  test("names the closest style on a near miss", () => {
    const result = normalizeDateFormatSpec({ locale: "cs", style: "shor" });
    expect(!result.ok && result.hint).toContain('Did you mean "short"');
  });
});

describe("numbers", () => {
  test.each([
    ["4 000", 4000],
    ["4 000", 4000],
    ["4,000.50", 4000.5],
    ["1 234,50", 1234.5],
    ["1.234,50", 1234.5],
    ["1.234.567", 1_234_567],
    ["EUR 100", 100],
    ["100 EUR", 100],
    ["100 Kč", 100],
    ["100.-", 100],
    ["1e3", 1000],
    ["-1 234,50", -1234.5],
    ["0", 0],
  ])("reads %s as %p", (input, expected) => {
    expect(valueOf(normalizeNumber(input))).toBe(expected);
  });

  test("a finite JSON number is taken verbatim", () => {
    expect(valueOf(normalizeNumber(1234.5))).toBe(1234.5);
    expect(normalizeNumber(Number.NaN).ok).toBe(false);
  });

  test("a single group-sized separator is an ask when no locale decides it", () => {
    const result = normalizeNumber("1,234");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.hint).toContain("Send 1234 or 1.234");
  });

  test("the field's locale decides the group-sized separator", () => {
    expect(valueOf(normalizeNumber("1,234", { locale: "en-GB" }))).toBe(1234);
    expect(valueOf(normalizeNumber("1,234", { locale: "cs" }))).toBe(1.234);
    expect(valueOf(normalizeNumber("1.234", { locale: "cs" }))).toBe(1234);
  });

  test.each([
    "",
    "abc",
    "oops1",
    "page 20",
    "1 USD 2",
    "1-2-3",
    "1e999",
    "-1e999",
    true,
    null,
    {},
  ])("asks about %p", (input) => {
    expect(normalizeNumber(input).ok).toBe(false);
  });
});

describe("booleans", () => {
  test.each([
    [true, true],
    [false, false],
    ["true", true],
    ["FALSE", false],
    ["yes", true],
    ["no", false],
    ["y", true],
    ["n", false],
    ["1", true],
    ["0", false],
    ["on", true],
    ["off", false],
    ["ano", true],
    ["ne", false],
    ["Áno", true],
    ["tak", true],
    ["nie", false],
    ["ja", true],
    ["nein", false],
    ["checked", true],
    ["unchecked", false],
    [1, true],
    [0, false],
  ])("reads %p as %p", (input, expected) => {
    expect(valueOf(normalizeBoolean(input))).toBe(expected);
  });

  test.each(["maybe", "", "2", 2, null])("asks about %p", (input) => {
    expect(normalizeBoolean(input).ok).toBe(false);
  });
});

describe("locales", () => {
  test.each([
    ["cs", "cs"],
    ["cs_CZ", "cs-CZ"],
    ["cs-cz", "cs-CZ"],
    [" EN-gb ", "en-GB"],
    ["pt_br", "pt-BR"],
  ])("reads %s as %s", (input, expected) => {
    expect(valueOf(normalizeLocale(input))).toBe(expected);
  });

  test.each(["", "not a locale", "!!", 5, null])("asks about %p", (input) => {
    expect(normalizeLocale(input).ok).toBe(false);
  });

  test("only the canonical spelling passes the persisted check", () => {
    // `new Intl.DateTimeFormat("cs_CZ")` throws, so the leniency above must
    // stop at the boundary and never reach a stored manifest.
    expect(isPlausibleLocale("cs-CZ")).toBe(true);
    expect(isPlausibleLocale("cs_CZ")).toBe(false);
    expect(isPlausibleLocale("")).toBe(false);
  });
});

describe("closed vocabularies", () => {
  const REGISTRIES = ["krs", "ares", "orsr"] as const;

  test("case and spacing are read, an exact value is taken verbatim", () => {
    expect(valueOf(normalizeEnumValue("krs", REGISTRIES))).toBe("krs");
    expect(valueOf(normalizeEnumValue(" KRS ", REGISTRIES))).toBe("krs");
  });

  test("a near miss asks and names the closest allowed value", () => {
    const result = normalizeEnumValue("kra", REGISTRIES);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.hint).toBe(
      'Did you mean "krs"? The allowed values are "krs", "ares", "orsr".',
    );
  });

  test("a value nothing is close to asks with the whole set", () => {
    const result = normalizeEnumValue("companies-house", REGISTRIES);
    expect(!result.ok && result.hint).toBe(
      'The allowed values are "krs", "ares", "orsr".',
    );
  });
});

describe("countries", () => {
  test.each([
    ["CZE", "CZE"],
    ["cze", "CZE"],
    [" CZE ", "CZE"],
    ["CZ", "CZE"],
    ["cz", "CZE"],
    ["Česko", "CZE"],
    ["česko", "CZE"],
    ["Cesko", "CZE"],
    ["Česká republika", "CZE"],
    ["Ceska  republika", "CZE"],
    ["Czechia", "CZE"],
    ["Czech Republic", "CZE"],
    ["Tschechien", "CZE"],
    ["Czechy", "CZE"],
    ["SVK", "SVK"],
    ["SK", "SVK"],
    ["Slovensko", "SVK"],
    ["Slovak Republic", "SVK"],
    ["Slowakei", "SVK"],
    ["POL", "POL"],
    ["Polska", "POL"],
    ["Polsko", "POL"],
    ["Poľsko", "POL"],
    ["AUT", "AUT"],
    ["Österreich", "AUT"],
    ["Osterreich", "AUT"],
    ["Rakousko", "AUT"],
    ["Rakúsko", "AUT"],
    ["HUN", "HUN"],
    ["Hungary", "HUN"],
    ["Magyarország", "HUN"],
    ["Magyar Koztarsasag", "HUN"],
    ["Maďarsko", "HUN"],
    // The supranational jurisdiction ISO assigns no code, spelled as the
    // corpus spells it.
    ["EU", "EU"],
    ["European Union", "EU"],
    ["Evropská unie", "EU"],
    ["Unia Europejska", "EU"],
    ["Germany", "DEU"],
    ["Deutschland", "DEU"],
    ["Bundesrepublik Deutschland", "DEU"],
  ])("reads %j as %s", (input, expected) => {
    const read = normalizeCountry(input);
    expect(read).toMatchObject({ ok: true, value: { alpha3: expected } });
  });

  test("returns both ISO spellings so a caller stores its own", () => {
    const read = normalizeCountry("Česko");
    expect(read.ok && read.value).toEqual({ alpha3: "CZE", alpha2: "CZ" });
  });

  test("an alpha-2 caller is told the code it stores", () => {
    const read = normalizeCountry("Czechia", { spelling: "alpha-2" });
    expect(read.ok && read.value.alpha2).toBe("CZ");
    expect(read.ok && read.note).toBe('Read "Czechia" as "CZ".');
  });

  // A spelling carrying two country readings is never guessed: `cs` is the
  // Czech language tag and was Czechoslovakia's code, and the two successor
  // states are different bodies of law.
  test("a spelling naming two countries asks with both named", () => {
    const read = normalizeCountry("cs", { tool: "search_case_law" });
    if (read.ok) {
      throw new Error(`"cs" resolved to ${read.value.alpha3}`);
    }
    expect(read.hint).toContain("CZE or SVK");
  });

  test.each([undefined, null, "", "   "])(
    "asks for a required country when given %j",
    (absent) => {
      const read = normalizeCountry(absent, {
        admitted: ["CZE"],
        tool: "search_case_law",
        parameter: "country",
      });
      expect(read.ok).toBe(false);
      if (read.ok) {
        return;
      }
      expect(read.expected).toBe("a country code, one of CZE");
      expect(read.hint).toContain("`country` on search_case_law is required");
    },
  );

  test("an unreadable spelling asks with the admitted codes", () => {
    const read = normalizeCountry("Atlantis", {
      admitted: ["CZE", "EU"],
      tool: "search_case_law",
    });
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.received).toBe('"Atlantis"');
    expect(read.hint).toContain("Admitted: CZE, EU.");
  });

  // Recognising a country is not admitting it: the corpus answers that, so a
  // country with no corpus still reads rather than failing to be spelled.
  test("a country the corpus lacks is still read", () => {
    const read = normalizeCountry("Francie", { admitted: ["CZE"] });
    expect(read.ok && read.value.alpha3).toBe("FRA");
  });

  // Wrapped in tuples so an array case reaches the reader as an array rather
  // than being spread into its elements.
  test.each([[42], [true], [["CZE"]], [{ country: "CZE" }]])(
    "asks when given the non-string %j",
    (input) => {
      expect(normalizeCountry(input).ok).toBe(false);
    },
  );
});

describe("the normalization annotation", () => {
  // The country kind has two canonical spellings and no default between them,
  // so the union branch requires one. Without it the first value reaching a
  // field declared `{ kind: "country" }` would have nothing to be read into.
  test("cannot declare a country without the spelling it stores", () => {
    // @ts-expect-error the country branch requires `country.spelling`
    const annotation: AgentInputNormalizationAnnotation = { kind: "country" };
    expect(annotation.kind).toBe(AGENT_INPUT_NORMALIZATION_KIND.country);
  });

  test("reads a country field once it says which code to store", () => {
    const declared = agentInputNormalization({
      kind: AGENT_INPUT_NORMALIZATION_KIND.country,
      country: { spelling: "alpha-2" },
    });
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: { country: { type: "string", ...declared } },
        },
        value: { country: "Czechia" },
      }),
    ).toMatchObject({ ok: true, value: { country: "CZ" } });
  });

  // An annotation whose kind is `country` but which never says which code to
  // store is not an annotation: the field keeps whatever its own schema says
  // rather than being read as a country.
  test("leaves a country field alone when the spelling is missing", () => {
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: {
            country: {
              type: "string",
              [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "country" },
            },
          },
        },
        value: { country: "Czechia" },
      }),
    ).toMatchObject({ ok: true, value: { country: "Czechia" } });
  });
});
