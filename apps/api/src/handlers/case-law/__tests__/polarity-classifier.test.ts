import { describe, expect, test } from "bun:test";

import {
  CLASSIFIABLE_POLARITIES,
  isValidPolarity,
  phraseToPattern,
  POLARITIES,
  POLARITY,
  POLARITY_PRECEDENCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import {
  compileRules,
  selectRuleMatch,
} from "@/api/handlers/case-law/polarity/rule-engine";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { createSafeId } from "@/api/lib/branded-types";

describe("extractContext", () => {
  const sections = [
    { text: "Header text about the case." },
    {
      text:
        "The court held that in accordance with sp. zn. 21 Cdo 1234/2020, " +
        "the previous ruling was correct. The defendant's arguments were " +
        "rejected as unfounded.",
    },
    { text: "The ruling is final." },
  ];

  test("extracts context around citation in specific section", () => {
    const ctx = extractContext(sections, "sp. zn. 21 Cdo 1234/2020", 1);
    expect(ctx).toContain("sp. zn. 21 Cdo 1234/2020");
    expect(ctx).toContain("in accordance with");
  });

  test("searches all sections when sectionIndex is null", () => {
    const ctx = extractContext(sections, "sp. zn. 21 Cdo 1234/2020", null);
    expect(ctx).toContain("sp. zn. 21 Cdo 1234/2020");
  });

  test("returns null when citation not found", () => {
    const ctx = extractContext(sections, "nonexistent citation", 0);
    expect(ctx).toBeNull();
  });
});

describe("phraseToPattern", () => {
  test("escapes special regex characters", () => {
    const pattern = phraseToPattern("srov.");
    expect(pattern).toBe("srov\\.");
  });

  test("replaces whitespace with flexible pattern", () => {
    const pattern = phraseToPattern("v souladu s");
    expect(pattern).toBe("v\\s+souladu\\s+s");
  });

  test("handles multiple spaces", () => {
    const pattern = phraseToPattern("k  tomu  blíže");
    expect(pattern).toBe("k\\s+tomu\\s+blíže");
  });
});

describe("isValidPolarity", () => {
  test("accepts a representative polarity", () => {
    expect(isValidPolarity("positive")).toBe(true);
  });

  test("rejects invalid values", () => {
    expect(isValidPolarity("maybe")).toBe(false);
    expect(isValidPolarity("")).toBe(false);
  });
});

describe("seed rules", () => {
  test("all rules have valid polarity", () => {
    for (const rule of SEED_RULES) {
      expect(isValidPolarity(rule.polarity)).toBe(true);
    }
  });

  test("all rules compile as valid regex", () => {
    for (const rule of SEED_RULES) {
      expect(() => new RegExp(rule.pattern, "iu")).not.toThrow();
    }
  });

  test("Czech positive rules match expected phrases", () => {
    const positiveRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "positive",
    );

    const testCases = [
      "v souladu s nálezem Ústavního soudu",
      "odkazuje na rozhodnutí",
      "jak konstatoval Nejvyšší soud",
    ];

    for (const text of testCases) {
      const matched = positiveRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("Czech negative rules match expected phrases", () => {
    const negativeRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "negative",
    );

    const testCases = [
      "na rozdíl od předchozího rozhodnutí",
      "tento závěr byl překonán",
      "nález byl zrušen",
    ];

    for (const text of testCases) {
      const matched = negativeRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("Czech supportive rules match expected phrases", () => {
    const supportiveRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "supportive",
    );

    const testCases = [
      "srov. rozhodnutí",
      "viz nález",
      "srovnej usnesení",
      "Nejvyšší soud judikoval",
      "lze odkázat na precedenční",
      "má oporu v rozhodovací činnosti",
      "přiléhavě odkázal na usnesení",
      "v judikatuře Nejvyššího soudu",
    ];

    for (const text of testCases) {
      const matched = supportiveRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("Czech neutral rules match procedural phrases", () => {
    const neutralRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "neutral",
    );

    const testCases = [
      "proti rozsudku Krajského soudu",
      "proti usnesení Nejvyššího soudu",
      "vedené u Okresního soudu",
      "vedeno pod sp. zn.",
    ];

    for (const text of testCases) {
      const matched = neutralRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("rules are partitioned by language", () => {
    const languages = [...new Set(SEED_RULES.map((r) => r.language))];
    expect(languages).toContain("cs");
    expect(languages).toContain("sk");
  });
});

describe("the classifier codomain is one list", () => {
  test("every polarity but the pipeline's own is classifiable", () => {
    expect([...CLASSIFIABLE_POLARITIES]).toEqual(
      POLARITIES.filter((polarity) => polarity !== POLARITY.UNKNOWN),
    );
  });

  test("`unknown` is not something a classifier may emit", () => {
    // It records that classification did not happen. A model returning it
    // would be claiming the pipeline failed, which is not its to say.
    expect([...CLASSIFIABLE_POLARITIES]).not.toContain(POLARITY.UNKNOWN);
  });

  test("both tiers label with the same set", () => {
    // The drift this pins: the rule table has always emitted `supportive`
    // (`srov.`, `viz`, `obdobně`), while the LLM schema offered only
    // positive/neutral/negative, so the same phrase was labelled one way by
    // a regex rule and another by the model. Declared set equals exercised
    // set, in both directions.
    const seeded = new Set<Polarity>(SEED_RULES.map((rule) => rule.polarity));

    expect([...seeded].toSorted()).toEqual(
      [...CLASSIFIABLE_POLARITIES].toSorted(),
    );
  });

  test("precedence covers every polarity", () => {
    expect(Object.keys(POLARITY_PRECEDENCE).toSorted()).toEqual(
      [...POLARITIES].toSorted(),
    );
  });
});

describe("rule precedence", () => {
  const rule = ({
    pattern,
    polarity,
  }: {
    pattern: string;
    polarity: Polarity;
  }) => ({
    id: createSafeId<"caseLawPolarityRule">(),
    pattern,
    polarity,
    confidence: 1,
  });

  test("a rare specific negative rule beats a popular generic positive one", () => {
    // The rows are listed the way the old `ORDER BY match_count DESC` query
    // returned them: the busy generic rule first. It used to win by arriving
    // first, and every win raised its count further, so a negative rule that
    // fired rarely could never overtake it. Nothing in the engine reads
    // `match_count` any more, which is why this input cannot even express
    // "popular" and the negative rule wins on severity alone.
    const rules = compileRules([
      rule({ pattern: "odkazuje\\s+na", polarity: POLARITY.POSITIVE }),
      rule({ pattern: "na\\s+rozdíl\\s+od", polarity: POLARITY.NEGATIVE }),
    ]);

    const match = selectRuleMatch(
      rules,
      "Na rozdíl od věci sp. zn. 21 Cdo 1234/2020, na kterou žalobce " +
        "odkazuje na podporu svého názoru, jde zde o jiný skutkový základ.",
    );

    expect(match?.polarity).toBe(POLARITY.NEGATIVE);
  });

  test("supportive does not outrank negative either", () => {
    const rules = compileRules([
      rule({ pattern: "srov\\.", polarity: POLARITY.SUPPORTIVE }),
      rule({ pattern: "překonán[aouy]?", polarity: POLARITY.NEGATIVE }),
    ]);

    const match = selectRuleMatch(
      rules,
      "Tento závěr byl překonán; srov. rozsudek velkého senátu.",
    );

    expect(match?.polarity).toBe(POLARITY.NEGATIVE);
  });

  test("the more specific pattern wins within one severity", () => {
    const rules = compileRules([
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
      rule({
        pattern: "viz\\s+rozsudek\\s+Nejvyššího",
        polarity: POLARITY.SUPPORTIVE,
      }),
    ]);

    expect(rules.at(0)?.pattern).toBe("viz\\s+rozsudek\\s+Nejvyššího");
  });

  test("neutral loses to positive", () => {
    const rules = compileRules([
      rule({ pattern: "proti\\s+rozsudku", polarity: POLARITY.NEUTRAL }),
      rule({ pattern: "v\\s+souladu\\s+s", polarity: POLARITY.POSITIVE }),
    ]);

    const match = selectRuleMatch(
      rules,
      "V souladu s citovaným rozhodnutím, proti rozsudku odvolacího soudu.",
    );

    expect(match?.polarity).toBe(POLARITY.POSITIVE);
  });

  test("the order does not depend on the order rows arrived in", () => {
    const rows = [
      rule({ pattern: "aaa", polarity: POLARITY.NEUTRAL }),
      rule({ pattern: "bbbb", polarity: POLARITY.NEUTRAL }),
      rule({ pattern: "cc", polarity: POLARITY.NEGATIVE }),
      rule({ pattern: "dddd", polarity: POLARITY.POSITIVE }),
    ];

    const forward = compileRules(rows).map((compiled) => compiled.id);
    const reversed = compileRules([...rows].toReversed()).map(
      (compiled) => compiled.id,
    );

    expect(forward).toEqual(reversed);
  });

  test("a rule carrying a pipeline-only polarity never matches", () => {
    // The CHECK constraint accepts `unknown` on a rule row, so this is
    // reachable from a hand-written insert. It must not become a match: the
    // citation would be labelled "classification did not happen" when the
    // regex tier had in fact just classified it.
    const rules = compileRules([
      rule({ pattern: "viz", polarity: POLARITY.UNKNOWN }),
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
    ]);

    expect(rules).toHaveLength(1);
    expect(selectRuleMatch(rules, "viz nález")?.polarity).toBe(
      POLARITY.SUPPORTIVE,
    );
  });

  test("a rule that does not compile is dropped, not fatal", () => {
    // Dropped, and reported: such a row can never fire, yet it still takes a
    // slot in its tier's budget, so leaving it invisible subtracts from the
    // working set forever.
    const rules = compileRules([
      rule({ pattern: "(unclosed", polarity: POLARITY.NEGATIVE }),
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
    ]);

    expect(rules.map((compiled) => compiled.pattern)).toEqual(["viz"]);
  });

  test("a match carries the rule's stored confidence", () => {
    const rules = compileRules([
      {
        id: createSafeId<"caseLawPolarityRule">(),
        pattern: "viz",
        polarity: POLARITY.SUPPORTIVE,
        confidence: 0.8,
      },
    ]);

    expect(selectRuleMatch(rules, "viz nález")?.confidence).toBe(0.8);
  });

  test("no match returns null", () => {
    const rules = compileRules([
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
    ]);

    expect(selectRuleMatch(rules, "nothing to see here")).toBeNull();
  });
});
