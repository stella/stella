import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  CITED_PART_RULES,
  classifyCitedPart,
} from "@/api/handlers/case-law/polarity/cited-part";

const TARGET = "A 12/2020";
const OTHER = "B 34/2021";
const LANGUAGES = {
  en: {
    opinions: [
      { cue: "dissenting opinion", part: "dissent" },
      { cue: "dissent", part: "dissent" },
      { cue: "concurring opinion", part: "concurrence" },
      { cue: "concurrence", part: "concurrence" },
      { cue: "majority opinion", part: "majority" },
    ],
    links: ["in", "of"],
    judgeLink: "of judge N in",
    ambiguous: ["separate opinion"],
  },
  cs: {
    opinions: [
      { cue: "disentní stanovisko", part: "dissent" },
      { cue: "nesouhlasné stanovisko", part: "dissent" },
      { cue: "konkurující stanovisko", part: "concurrence" },
      { cue: "souhlasné stanovisko", part: "concurrence" },
      { cue: "většinový názor", part: "majority" },
    ],
    links: ["k", "v", "ve věci"],
    judgeLink: "soudce N k",
    ambiguous: ["odlišné stanovisko", "odlišného stanoviska"],
  },
  sk: {
    opinions: [
      { cue: "disentné stanovisko", part: "dissent" },
      { cue: "nesúhlasné stanovisko", part: "dissent" },
      { cue: "súhlasné stanovisko", part: "concurrence" },
      { cue: "väčšinové stanovisko", part: "majority" },
    ],
    links: ["k", "v", "vo veci"],
    judgeLink: "sudcu N k",
    ambiguous: ["odlišné stanovisko", "osobitné stanovisko"],
  },
} as const satisfies Record<
  keyof typeof CITED_PART_RULES,
  {
    opinions: readonly {
      cue: string;
      part: "dissent" | "concurrence" | "majority";
    }[];
    links: readonly string[];
    judgeLink: string;
    ambiguous: readonly string[];
  }
>;

const languages = Object.entries(LANGUAGES);
const opinions = languages.flatMap(([language, fixture]) =>
  fixture.opinions.map(({ cue, part }) => ({ language, cue, part, fixture })),
);

const classify = (context: string, language: string) =>
  classifyCitedPart({ contexts: [context], citationText: TARGET, language });

describe("the cited opinion belongs to the target reference", () => {
  test("the binding fixtures cover every supported language", () => {
    expect(Object.keys(LANGUAGES).toSorted()).toEqual(
      Object.keys(CITED_PART_RULES).toSorted(),
    );
  });

  test.each(opinions)(
    "identifies a bound $language $cue",
    ({ language, cue, part, fixture }) => {
      for (const link of fixture.links) {
        expect(classify(`${cue} ${link} ${TARGET}`, language)).toBe(part);
      }
      expect(classify(`${TARGET} (${cue})`, language)).toBe(part);
      expect(classify(`${cue} ${fixture.judgeLink} ${TARGET}`, language)).toBe(
        part,
      );
      if (language === "en") {
        expect(classify(`${TARGET}'s ${cue}`, language)).toBe(part);
      }
    },
  );

  test.each(languages)(
    "does not label an ambiguous opinion in %s",
    (language, fixture) => {
      for (const cue of fixture.ambiguous) {
        expect(classify(`${cue} ${fixture.links[0]} ${TARGET}`, language)).toBe(
          "not-stated",
        );
        expect(classify(`${TARGET} (${cue})`, language)).toBe("not-stated");
      }
    },
  );

  test.each(opinions)(
    "does not borrow a $language $cue from another reference in either order",
    ({ language, cue, fixture }) => {
      const otherOpinion = `${cue} ${fixture.links[0]} ${OTHER}`;
      for (const separator of [". ", "; ", " and "]) {
        expect(classify(`${TARGET}${separator}${otherOpinion}`, language)).toBe(
          "not-stated",
        );
        expect(classify(`${otherOpinion}${separator}${TARGET}`, language)).toBe(
          "not-stated",
        );
      }
      expect(classify(`${TARGET}, ${OTHER} (${cue})`, language)).toBe(
        "not-stated",
      );
      expect(
        classify(`${cue} ${fixture.links[0]} ${OTHER}, ${TARGET}`, language),
      ).toBe("not-stated");
    },
  );

  test.each(languages)(
    "counts conflicts only between opinions bound to the same target in %s",
    (language, fixture) => {
      for (const targetOpinion of fixture.opinions) {
        for (const otherOpinion of fixture.opinions) {
          if (targetOpinion.part === otherOpinion.part) {
            continue;
          }
          const targetContext = `${TARGET} (${targetOpinion.cue})`;
          const otherContext = `${OTHER} (${otherOpinion.cue})`;
          expect(classify(`${targetContext}; ${otherContext}`, language)).toBe(
            targetOpinion.part,
          );
          expect(classify(`${otherContext}; ${targetContext}`, language)).toBe(
            targetOpinion.part,
          );
          expect(
            classifyCitedPart({
              contexts: [targetContext, `${TARGET} (${otherOpinion.cue})`],
              citationText: TARGET,
              language,
            }),
          ).toBe("not-stated");
        }
      }
    },
  );

  test("normalizes decomposed diacritics before binding an opinion", () => {
    for (const [language, fixture] of languages) {
      for (const { cue, part } of fixture.opinions) {
        if (normalizeUnicode(cue, "NFD") === cue) {
          continue;
        }
        const context = `${TARGET} (${cue})`;
        expect(normalizeUnicode(context, "NFD")).not.toBe(context);
        expect(classify(normalizeUnicode(context, "NFD"), language)).toBe(part);
      }
    }
  });

  test("requires a supported language, target occurrence and syntactic link", () => {
    expect(classify(`${TARGET} (dissenting opinion)`, "cs")).toBe("not-stated");
    expect(classify(`${TARGET} (dissenting opinion)`, "und")).toBe(
      "not-stated",
    );
    expect(classify(`dissenting opinion in ${OTHER}`, "en")).toBe("not-stated");
    expect(
      classify(`${TARGET}. The dissenting opinion explains why.`, "en"),
    ).toBe("not-stated");
    expect(classify(`dissenting opinion. ${TARGET}`, "en")).toBe("not-stated");
    expect(classify(`Judge N in ${TARGET}`, "en")).toBe("not-stated");
    expect(
      classifyCitedPart({
        contexts: ["See X. The dissenting opinion in Y explains why."],
        citationText: "X",
        language: "en",
      }),
    ).toBe("not-stated");
    expect(
      classifyCitedPart({
        contexts: ["dissenting opinion of judge N in Y in X"],
        citationText: "X",
        language: "en",
      }),
    ).toBe("not-stated");
  });

  test("inserting an unrelated reference with its own cue preserves the target cited part", () => {
    assertProperty(
      "inserting an unrelated reference with its own cue preserves the target cited part",
      fc.property(
        fc.constantFrom(
          ...languages.flatMap(([language, fixture]) => {
            const targets = [
              ...fixture.opinions.map(({ cue, part }) => ({
                context: `${TARGET} (${cue})`,
                part,
              })),
              { context: TARGET, part: "not-stated" as const },
            ];
            return targets.flatMap((target) =>
              fixture.opinions.map((other) => ({ language, target, other })),
            );
          }),
        ),
        fc.integer({ min: 1, max: 999 }),
        fc.constantFrom(". ", "; ", " and "),
        fc.boolean(),
        ({ language, target, other }, number, separator, insertBefore) => {
          const targetContext = target.context;
          const unrelatedContext = `B ${number}/2021 (${other.cue})`;
          const extended = insertBefore
            ? `${unrelatedContext}${separator}${targetContext}`
            : `${targetContext}${separator}${unrelatedContext}`;
          const expected = target.part;
          expect(classify(targetContext, language)).toBe(expected);
          expect(classify(extended, language)).toBe(expected);
        },
      ),
    );
  });
});
