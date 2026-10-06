import { expect, test } from "bun:test";

import { REPORTED_PARTY_SUBMISSION_GROUP } from "@/api/handlers/case-law/polarity/consts";
import {
  compileRules,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import {
  CS_DECISION_ANCHOR,
  SK_DECISION_ANCHOR,
  WORDS_BETWEEN,
  SEED_RULES,
} from "@/api/handlers/case-law/polarity/seed-rules";
import { toSafeId } from "@/api/lib/branded-types";

const rulesFor = (language: string) =>
  compileRules(
    [
      ...SEED_RULES.filter((rule) => rule.language === language),
      {
        pattern: `${language === "cs" ? CS_DECISION_ANCHOR : SK_DECISION_ANCHOR}\\p{L}*\\s+${WORDS_BETWEEN}(?:řeší|rieši)\\s+${WORDS_BETWEEN}odlišn\\p{L}+\\s+(?:situac|situáci)`,
        polarity: "negative",
      } as const,
    ].map((rule, index) => ({
      id: toSafeId<"caseLawPolarityRule">(String(index)),
      pattern: rule.pattern,
      polarity: rule.polarity,
      confidence: 1,
    })),
  );

const csRules = rulesFor("cs");
const skRules = rulesFor("sk");

test("reported treatment is neutral while a court's distinguishing remains negative", () => {
  for (const context of [
    "stěžovatel vyjádřil přesvědčení, že uvedený rozsudek řeší poněkud odlišnou situaci",
    "žalobce tvrdí, že tento rozsudek nelze aplikovat",
    "stěžovatel uvedl, že nález nadále neobstojí",
  ]) {
    expect(selectCitationPolarity(csRules, context)?.polarity).toBe("neutral");
  }
  expect(
    selectCitationPolarity(
      csRules,
      "uvedený rozsudek řeší poněkud odlišnou situaci",
    )?.polarity,
  ).toBe("negative");
  expect(
    selectCitationPolarity(
      skRules,
      "sťažovateľ tvrdí, že rozhodnutie rieši odlišnú situáciu",
    )?.polarity,
  ).toBe("neutral");
  expect(
    selectCitationPolarity(skRules, "rozhodnutie rieši odlišnú situáciu")
      ?.polarity,
  ).toBe("negative");
});

const scopedRules = compileRules([
  {
    id: toSafeId<"caseLawPolarityRule">("negative"),
    pattern: "decision differs",
    polarity: "negative",
    confidence: 0.9,
  },
  {
    id: toSafeId<"caseLawPolarityRule">("reported"),
    pattern: "speaker alleges (?<reportedPartySubmission>[^.;]+)",
    polarity: "neutral",
    confidence: 0.8,
  },
  {
    id: toSafeId<"caseLawPolarityRule">("supportive"),
    pattern: "see decision",
    polarity: "supportive",
    confidence: 1,
  },
]);

test("scope captures work without language-specific precedence", () => {
  expect(
    selectCitationPolarity(scopedRules, "speaker alleges the decision differs"),
  ).toEqual({
    polarity: "neutral",
    ruleId: toSafeId<"caseLawPolarityRule">("reported"),
    confidence: 0.8,
  });
  expect(
    selectCitationPolarity(
      scopedRules,
      "see decision; speaker alleges decision differs",
    )?.polarity,
  ).toBe("neutral");
});

test("every occurrence is read and an earlier reported cue cannot hide a court cue", () => {
  for (const context of [
    "speaker alleges decision differs. The decision differs",
    "The decision differs. speaker alleges decision differs",
    "speaker alleges decision differs; the decision differs",
    "speaker alleges decision differs. speaker alleges decision differs. The decision differs",
  ]) {
    expect(selectCitationPolarity(scopedRules, context)?.polarity).toBe(
      "negative",
    );
  }
});

test("the scope applies to each mention before aggregation", () => {
  expect(
    selectCitationPolarity(scopedRules, [
      "speaker alleges decision differs",
      "see decision",
    ])?.polarity,
  ).toBe("supportive");
  expect(
    selectCitationPolarity(scopedRules, [
      "speaker alleges decision differs",
      "The decision differs",
    ])?.polarity,
  ).toBe("negative");
  expect(
    selectCitationPolarity(scopedRules, [
      "see decision",
      "The decision differs",
    ])?.polarity,
  ).toBe("mixed");
});

test("the captured span governs only matches fully inside it", () => {
  const rules = compileRules([
    {
      id: toSafeId<"caseLawPolarityRule">("negative"),
      pattern: "decision differs",
      polarity: "negative",
      confidence: 1,
    },
    {
      id: toSafeId<"caseLawPolarityRule">("reported"),
      pattern: "decision differs (?<reportedPartySubmission>other text)",
      polarity: "neutral",
      confidence: 1,
    },
  ]);
  expect(
    selectCitationPolarity(rules, "decision differs other text")?.polarity,
  ).toBe("negative");
});

test("ordinary procedural neutral cues never suppress a departure", () => {
  const rules = compileRules([
    {
      id: toSafeId<"caseLawPolarityRule">("negative"),
      pattern: "decision differs",
      polarity: "negative",
      confidence: 1,
    },
    {
      id: toSafeId<"caseLawPolarityRule">("procedural"),
      pattern: "appeal against decision",
      polarity: "neutral",
      confidence: 1,
    },
  ]);
  expect(
    selectCitationPolarity(
      rules,
      "appeal against decision; the decision differs",
    )?.polarity,
  ).toBe("negative");
});

test("every seeded reported-submission capture is a neutral rule with a finite boundary", () => {
  const scoped = SEED_RULES.filter((rule) =>
    rule.pattern.includes(`(?<${REPORTED_PARTY_SUBMISSION_GROUP}>`),
  );
  expect(scoped).not.toBeEmpty();
  for (const rule of scoped) {
    expect(rule.polarity).toBe("neutral");
    const context =
      rule.language === "cs"
        ? "stěžovatel tvrdí, že rozsudek nelze aplikovat. rozsudek nelze aplikovat"
        : "sťažovateľ tvrdí, že na rozdiel od rozhodnutia platí iný záver. na rozdiel od rozhodnutia platí iný záver";
    expect(
      selectCitationPolarity(rulesFor(rule.language), context)?.polarity,
    ).toBe("negative");
  }
});

test("a reported submission ends before an independent court clause", () => {
  for (const court of [
    "soud",
    "krajský soud",
    "Nejvyšší soud",
    "Nejvyšší správní soud",
    "dovolací soud",
    "senát",
    "tříčlenný senát",
  ]) {
    for (const contrast of ["avšak", "ale", "nicméně"]) {
      expect(
        selectCitationPolarity(
          csRules,
          `stěžovatel tvrdí, že rozsudek nelze aplikovat (sp. zn. 1 Cdo 1/2020), ${contrast} ${court} konstatuje, že nález nadále neobstojí`,
        )?.polarity,
      ).toBe("negative");
    }
  }
  for (const court of ["súd", "krajský súd", "najvyšší súd", "senát"]) {
    expect(
      selectCitationPolarity(
        skRules,
        `sťažovateľ tvrdí, že na rozdiel od rozhodnutia platí iný záver, avšak ${court} konštatuje, že prekonáva rozhodnutie`,
      )?.polarity,
    ).toBe("negative");
  }
});

test("citation abbreviations and dates stay inside the reported submission", () => {
  for (const reference of [
    "rozsudek ze dne 1. 2. 2020, sp. zn. 1 Cdo 1/2020",
    "rozsudek ze dne 29. května 2020, sp. zn. 1 Cdo 1/2020",
    "nález sp. zn. Pl. ÚS 1/20",
    "nález sp. zn. IV. ÚS 1/20",
    "nález sp.zn.I. ÚS 1/20",
    "nález č. j. Pl. ÚS 1/20",
    "nález č.j.IV. ÚS 1/20",
    "rozsudek č. j. 1 Cdo 1/2020",
  ]) {
    expect(
      selectCitationPolarity(
        csRules,
        `stěžovatel tvrdí, že ${reference} překonán`,
      )?.polarity,
    ).toBe("neutral");
    expect(
      selectCitationPolarity(
        csRules,
        `stěžovatel tvrdí, že ${reference} překonán. Soud konstatuje, že nález nadále neobstojí`,
      )?.polarity,
    ).toBe("negative");
  }
});

test("scope without a departure retains normal precedence and unmatched windows stay empty", () => {
  expect(
    selectCitationPolarity(scopedRules, "speaker alleges nothing; see decision")
      ?.polarity,
  ).toBe("supportive");
  expect(
    selectCitationPolarity(scopedRules, "speaker alleges nothing")?.polarity,
  ).toBe("neutral");
  expect(selectCitationPolarity(scopedRules, "nothing to classify")).toBeNull();
  expect(
    selectCitationPolarity(
      scopedRules,
      "speaker alleges decision differs; speaker alleges decision differs",
    )?.polarity,
  ).toBe("neutral");
});

test("an unmatched optional capture cannot suppress a departure", () => {
  const rules = compileRules([
    {
      id: toSafeId<"caseLawPolarityRule">("negative"),
      pattern: "decision differs",
      polarity: "negative",
      confidence: 1,
    },
    {
      id: toSafeId<"caseLawPolarityRule">("reported"),
      pattern: "speaker(?: alleges (?<reportedPartySubmission>[^.;]+))?",
      polarity: "neutral",
      confidence: 1,
    },
  ]);
  expect(
    selectCitationPolarity(rules, "speaker. decision differs")?.polarity,
  ).toBe("negative");
});
