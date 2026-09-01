import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";

const variant = (language: string) => ({ language, id: `id-${language}` });

const languageTag = fc
  .tuple(
    fc.constantFrom("cs", "sk", "en", "fr", "de", "pl", "pt", "es", "el", "ga"),
    fc.option(fc.constantFrom("gb", "us", "br", "cz"), { nil: null }),
  )
  .map(([primary, region]) =>
    region === null ? primary : `${primary}-${region}`,
  );

const variants = fc
  .uniqueArray(languageTag, { minLength: 1, maxLength: 12 })
  .map((languages) => languages.map(variant));

describe("picking the language version to open", () => {
  test("nothing to choose from", () => {
    expect(
      pickPreferredCaseLawLanguageVariant({ alternates: [], uiLocale: "cs" }),
    ).toBeNull();
  });

  test("the UI language wins when the decision exists in it", () => {
    const alternates = [variant("fr"), variant("en"), variant("cs")];

    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates,
        matchedLanguage: "fr",
        uiLocale: "cs",
      }),
    ).toEqual(variant("cs"));
  });

  test("a regional UI locale reads the version in its language", () => {
    const alternates = [variant("fr"), variant("pt"), variant("en")];

    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates,
        matchedLanguage: "fr",
        uiLocale: "pt-BR",
      }),
    ).toEqual(variant("pt"));
  });

  test("the version that matched the search comes before English", () => {
    const alternates = [variant("en"), variant("de"), variant("fr")];

    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates,
        matchedLanguage: "fr",
        uiLocale: "cs",
      }),
    ).toEqual(variant("fr"));
  });

  test("English is the fallback, then the first available version", () => {
    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates: [variant("de"), variant("en"), variant("fr")],
        uiLocale: "cs",
      }),
    ).toEqual(variant("en"));
    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates: [variant("de"), variant("fr")],
        uiLocale: "cs",
      }),
    ).toEqual(variant("de"));
  });

  test("always returns one of the alternates, and the UI language whenever it is offered", () => {
    fc.assert(
      fc.property(
        variants,
        languageTag,
        fc.option(languageTag, { nil: undefined }),
        (alternates, uiLocale, matchedLanguage) => {
          const picked = pickPreferredCaseLawLanguageVariant({
            alternates,
            matchedLanguage,
            uiLocale,
          });

          expect(alternates).toContainEqual(picked);
          const exact = alternates.find(
            (alternate) => alternate.language === uiLocale,
          );
          if (exact !== undefined) {
            expect(picked).toEqual(exact);
          }
        },
      ),
    );
  });
});
