import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  POLARITY,
  POLARITY_RULE_KIND,
} from "@/api/handlers/case-law/polarity/consts";
import {
  compileRules,
  isValidRuleKindPolarity,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { toSafeId } from "@/api/lib/branded-types";

const compiledRulesFor = (language: string) =>
  compileRules(
    SEED_RULES.filter((rule) => rule.language === language).map(
      (rule, index) => ({
        ...rule,
        id: toSafeId<"caseLawPolarityRule">(`${language}-${index}`),
        confidence: 1,
      }),
    ),
  );

const FORM_MARKERS = {
  cs: [
    "srov.",
    "viz",
    "obdobně",
    "přiměřeně",
    "k tomu blíže",
    "shodně též",
    "srovnej",
    "např.",
    "(sp. zn.",
  ],
  sk: ["porov.", "pozri", "obdobne", "napr.", "(sp. zn."],
} as const;

const REJECTION_CUES = {
  cs: [
    "nepoužitelný závěr rozhodnutí",
    "nepřiléhavý závěr rozsudku",
    "bezcenný závěr nálezu",
    "rozhodnutí se neuplatní",
    "rozsudek nedopadá",
    "rozhodnutí je skutkově odlišné",
  ],
  sk: [
    "nepoužiteľný záver rozhodnutia",
    "nepriliehavý záver rozsudku",
    "bezcenný záver nálezu",
    "rozhodnutie sa nevzťahuje",
    "rozsudok je skutkovo odlišný",
  ],
} as const;

const languageArb = fc.constantFrom("cs", "sk");

describe("polarity rule kinds", () => {
  test("every registered rule obeys its kind contract", () => {
    for (const rule of SEED_RULES) {
      expect({ rule, valid: isValidRuleKindPolarity(rule) }).toEqual({
        rule,
        valid: true,
      });
    }
  });

  test("the marker properties exercise every registered form rule", () => {
    for (const rule of SEED_RULES.filter(
      ({ kind }) => kind === POLARITY_RULE_KIND.FORM,
    )) {
      const markers = Object.entries(FORM_MARKERS).find(
        ([language]) => language === rule.language,
      )?.[1];
      expect(
        markers?.some((marker) => new RegExp(rule.pattern, "iu").test(marker)),
      ).toBe(true);
    }
    for (const [language, markers] of Object.entries(FORM_MARKERS)) {
      const forms = SEED_RULES.filter(
        (rule) =>
          rule.kind === POLARITY_RULE_KIND.FORM && rule.language === language,
      );
      for (const marker of markers) {
        expect(
          forms.some((rule) => new RegExp(rule.pattern, "iu").test(marker)),
        ).toBe(true);
      }
    }
  });

  test("the guard rejects a form rule that produces supportive", () => {
    expect(
      isValidRuleKindPolarity({
        kind: POLARITY_RULE_KIND.FORM,
        polarity: POLARITY.SUPPORTIVE,
      }),
    ).toBe(false);
  });

  test("form markers cannot overturn an applicability rejection", () => {
    assertProperty(
      "form markers cannot overturn an applicability rejection",
      fc.property(
        languageArb,
        fc.nat(),
        fc.nat({ max: 3 }),
        (language, markerIndex, insertionPoint) => {
          const markers = FORM_MARKERS[language];
          const cues = REJECTION_CUES[language];
          const marker = markers[markerIndex % markers.length];
          const cue = cues[markerIndex % cues.length];
          const parts = ["Úvod textu", cue, "závěr textu"];
          parts.splice(insertionPoint, 0, marker);

          expect(
            selectCitationPolarity(compiledRulesFor(language), parts.join(" "))
              ?.polarity,
          ).toBe(POLARITY.NEGATIVE);
        },
      ),
    );
  });

  test("windows containing only form markers are neutral", () => {
    assertProperty(
      "windows containing only form markers are neutral",
      fc.property(
        languageArb,
        fc.array(fc.nat(), { minLength: 1, maxLength: 12 }),
        (language, indexes) => {
          const markers = FORM_MARKERS[language];
          const window = indexes
            .map((index) => markers[index % markers.length])
            .join(" ");

          expect(
            selectCitationPolarity(compiledRulesFor(language), window)
              ?.polarity,
          ).toBe(POLARITY.NEUTRAL);
        },
      ),
    );
  });
});
