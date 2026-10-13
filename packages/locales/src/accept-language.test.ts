import { expect, test } from "bun:test";

import { resolveAcceptLanguage } from "./helpers";
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
});

test("unsupported, excluded and malformed ranges cannot select a catalogue", () => {
  for (const header of [
    undefined,
    "",
    "*",
    "zz",
    "cs;q=0",
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
