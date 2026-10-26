import { expect, test } from "bun:test";

import { negotiateAcceptLanguage, resolveAcceptLanguage } from "./helpers";
import { UI_LOCALES } from "./languages";

test("every supported locale is selectable with browser quality weights", () => {
  for (const locale of UI_LOCALES) {
    expect(resolveAcceptLanguage(`zz;q=1,${locale};q=0.9,en;q=0.1`)).toBe(
      locale,
    );
    expect(resolveAcceptLanguage(`${locale};q=0,en;q=0.5`)).toBe("en");
  }
});

test("quality wins over order, equal qualities retain order, and regional tags resolve", () => {
  expect(resolveAcceptLanguage("en;q=0.2,cs-CZ;q=0.9,de;q=0.8")).toBe("cs");
  expect(resolveAcceptLanguage("de;q=0.9,cs;q=0.9")).toBe("de");
  expect(resolveAcceptLanguage("CS-cz, en;q=0.9")).toBe("cs");
  expect(resolveAcceptLanguage("de;q=0.,cs;q=0.001")).toBe("cs");
  expect(resolveAcceptLanguage("de;q=1.,cs;q=0.999")).toBe("de");
  expect(resolveAcceptLanguage("de;q=0.5,cs;q=0.500")).toBe("de");
  expect(resolveAcceptLanguage("de;q=0.001,cs;q=0.002")).toBe("cs");
});

test("unsupported, excluded and malformed ranges cannot select a catalogue", () => {
  for (const header of [
    undefined,
    "",
    "*",
    "zz",
    "cs;q=0",
    "cs;q=0.",
    "cs;q=-1",
    "cs;q=2",
    "cs;q=NaN",
    "cs;q=0.1234",
    "cs;q=1;extra=yes",
    "cs!",
    "cs-",
    "cs;q=1.001",
  ]) {
    expect(resolveAcceptLanguage(header)).toBe("en");
  }
});

test("catalogue and region come from the same winning browser language", () => {
  for (const [header, locale, region] of [
    ["ar-SA", "ar", "SA"],
    ["ar-AE", "ar", "AE"],
    ["ar-Arab-AE", "ar", "AE"],
    ["AR-ae", "ar", "AE"],
    ["ar-SA;q=0.2,ar-AE;q=0.9", "ar", "AE"],
    ["ar-SA;q=0,ar-AE", "ar", "AE"],
    ["ar-SA;q=0.9,ar-AE;q=0.9", "ar", "SA"],
    ["ar-SA;q=0.2,ar;q=0.9", "ar", ""],
    ["zz-SA,cs-CZ;q=0.5", "cs", "CZ"],
    ["ar-u,cs-CZ;q=0.5", "cs", "CZ"],
    ["es-419", "es", "419"],
    ["pt-PT", "pt-BR", "PT"],
    [undefined, "en", ""],
  ] as const) {
    expect(negotiateAcceptLanguage(header)).toEqual({ locale, region });
    expect(resolveAcceptLanguage(header)).toBe(locale);
  }
});
