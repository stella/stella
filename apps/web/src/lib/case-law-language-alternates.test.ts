import { describe, expect, test } from "bun:test";

import { createCaseLawLanguageAlternateLinks } from "@/lib/case-law-language-alternates";

describe("case-law language alternates", () => {
  test("does not create hreflang links for monolingual decisions", () => {
    expect(
      createCaseLawLanguageAlternateLinks({
        alternates: [{ href: "/cs", language: "cs" }],
        createHref: (alternate) => alternate.href,
      }),
    ).toEqual([]);
  });

  test("normalizes and dedupes official language alternate links", () => {
    expect(
      createCaseLawLanguageAlternateLinks({
        alternates: [
          { href: "/en", language: "EN" },
          { href: "/en-duplicate", language: "en" },
          { href: "/cs", language: "cs" },
        ],
        createHref: (alternate) => alternate.href,
      }),
    ).toEqual([
      { hreflang: "en", href: "/en" },
      { hreflang: "cs", href: "/cs" },
      { hreflang: "x-default", href: "/en" },
    ]);
  });

  test("uses the first valid alternate as x-default when English is unavailable", () => {
    expect(
      createCaseLawLanguageAlternateLinks({
        alternates: [
          { href: "/invalid", language: "not a language" },
          { href: "/fr", language: "fr" },
          { href: "/cs", language: "cs" },
        ],
        createHref: (alternate) => alternate.href,
      }),
    ).toEqual([
      { hreflang: "fr", href: "/fr" },
      { hreflang: "cs", href: "/cs" },
      { hreflang: "x-default", href: "/fr" },
    ]);
  });

  test("does not create a fake hreflang set from one valid language", () => {
    expect(
      createCaseLawLanguageAlternateLinks({
        alternates: [
          { href: "/invalid", language: "not a language" },
          { href: "/fr", language: "fr" },
          { href: "/fr-duplicate", language: "FR" },
        ],
        createHref: (alternate) => alternate.href,
      }),
    ).toEqual([]);
  });

  test("does not emit x-default or namespace-worthy links without valid languages", () => {
    expect(
      createCaseLawLanguageAlternateLinks({
        alternates: [
          { href: "/invalid", language: "not a language" },
          { href: "/also-invalid", language: "" },
        ],
        createHref: (alternate) => alternate.href,
      }),
    ).toEqual([]);
  });
});
