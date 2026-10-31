import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { caseLawReadingLanguages } from "@stll/api-contract/case-law-reading-languages";
import { propertyConfig } from "@stll/property-testing";

import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";

const variant = (language: string) => ({ language, id: `id-${language}` });

const languageTag = fc
  .tuple(
    fc.constantFrom("cs", "sk", "en", "fr", "de", "pl", "pt", "es", "el", "bg"),
    fc.option(fc.constantFrom("gb", "us", "br", "cz"), { nil: null }),
  )
  .map(([primary, region]) =>
    region === null ? primary : `${primary}-${region}`,
  );

const variants = fc
  .uniqueArray(languageTag, {
    minLength: 1,
    maxLength: 12,
    selector: (tag) => tag.split("-")[0],
  })
  .map((languages) => languages.map(variant));

/** An English UI in a Czech practice: the reader who reported the order. */
const ENGLISH_UI_CZECH_PRACTICE = caseLawReadingLanguages({
  uiLocale: "en",
  practiceCountries: ["CZ"],
});

describe("picking the language version to open", () => {
  test("nothing to choose from", () => {
    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates: [],
        readingLanguages: ENGLISH_UI_CZECH_PRACTICE,
      }),
    ).toBeNull();
  });

  test("the UI language, then the practice language, then French, then the row's own version", () => {
    const greekCase = [variant("bg"), variant("el"), variant("fr")];
    const pick = (alternates: ReturnType<typeof variant>[]) =>
      pickPreferredCaseLawLanguageVariant({
        alternates,
        rowLanguage: "el",
        readingLanguages: ENGLISH_UI_CZECH_PRACTICE,
      })?.language;

    expect(pick([...greekCase, variant("cs"), variant("en")])).toBe("en");
    expect(pick([...greekCase, variant("cs")])).toBe("cs");
    expect(pick(greekCase)).toBe("fr");
    // In none of the reader's languages: the version the row stands for,
    // which the server chose as the language of the case.
    expect(pick([variant("bg"), variant("el")])).toBe("el");
  });

  test("a regional UI locale reads the version in its language", () => {
    expect(
      pickPreferredCaseLawLanguageVariant({
        alternates: [variant("fr"), variant("pt"), variant("en")],
        rowLanguage: "fr",
        readingLanguages: caseLawReadingLanguages({ uiLocale: "pt-BR" }),
      }),
    ).toEqual(variant("pt"));
  });

  test("always returns one of the alternates, and the best reading language offered", () => {
    fc.assert(
      fc.property(
        variants,
        languageTag,
        fc.option(languageTag, { nil: undefined }),
        (alternates, uiLocale, rowLanguage) => {
          const readingLanguages = caseLawReadingLanguages({ uiLocale });
          const picked = pickPreferredCaseLawLanguageVariant({
            alternates,
            rowLanguage,
            readingLanguages,
          });

          expect(picked).not.toBeNull();
          if (picked === null) {
            return;
          }
          expect(alternates).toContainEqual(picked);
          const best = readingLanguages.find((language) =>
            alternates.some(
              (alternate) => alternate.language.split("-")[0] === language,
            ),
          );
          if (best !== undefined) {
            expect(picked.language.split("-")[0]).toBe(best);
          }
        },
      ),
      propertyConfig(),
    );
  });
});
