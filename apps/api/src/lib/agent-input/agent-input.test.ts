import { describe, expect, test } from "bun:test";

import { normalizeBoolean } from "@/api/lib/agent-input/boolean";
import { normalizeDateFormatSpec } from "@/api/lib/agent-input/date-format-spec";
import { normalizeDateValue } from "@/api/lib/agent-input/date-value";
import { normalizeEnumValue } from "@/api/lib/agent-input/enum-value";
import {
  isPlausibleLocale,
  normalizeLocale,
} from "@/api/lib/agent-input/locale";
import type { Normalized } from "@/api/lib/agent-input/normalized";
import { normalizeNumber } from "@/api/lib/agent-input/number";

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
    expect(result.ok === false && result.hint).toBe(
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
  ])("reads %s", (spec, expected) => {
    expect(valueOf(normalizeDateFormatSpec(spec))).toEqual(expected);
  });

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
  ])("reads the wire object %p", (spec, expected) => {
    expect(valueOf(normalizeDateFormatSpec(spec))).toEqual(expected);
  });

  test("a bare style names no locale, so it is an ask", () => {
    // The style test runs first: "iso" is structurally a language tag, and
    // reading it as one would silently render dates in an unknown language.
    for (const spec of ["iso", "long", "short"]) {
      expect(normalizeDateFormatSpec(spec).ok).toBe(false);
    }
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
    expect(result.ok === false && result.hint).toContain(
      'Did you mean "short"',
    );
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
    expect(result.ok === false && result.hint).toContain("Send 1234 or 1.234");
  });

  test("the field's locale decides the group-sized separator", () => {
    expect(valueOf(normalizeNumber("1,234", { locale: "en-GB" }))).toBe(1234);
    expect(valueOf(normalizeNumber("1,234", { locale: "cs" }))).toBe(1.234);
    expect(valueOf(normalizeNumber("1.234", { locale: "cs" }))).toBe(1234);
  });

  test.each(["", "abc", "1-2-3", true, null, {}])("asks about %p", (input) => {
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
    expect(result.ok === false && result.hint).toBe(
      'Did you mean "krs"? The allowed values are "krs", "ares", "orsr".',
    );
  });

  test("a value nothing is close to asks with the whole set", () => {
    const result = normalizeEnumValue("companies-house", REGISTRIES);
    expect(result.ok === false && result.hint).toBe(
      'The allowed values are "krs", "ares", "orsr".',
    );
  });
});
