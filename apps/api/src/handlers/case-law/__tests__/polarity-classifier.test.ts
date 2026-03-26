import { describe, expect, test } from "bun:test";

import {
  isValidPolarity,
  phraseToPattern,
  POLARITY_WEIGHT,
} from "@/api/handlers/case-law/polarity/consts";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";

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
  test("accepts valid polarities", () => {
    expect(isValidPolarity("positive")).toBe(true);
    expect(isValidPolarity("supportive")).toBe(true);
    expect(isValidPolarity("neutral")).toBe(true);
    expect(isValidPolarity("negative")).toBe(true);
    expect(isValidPolarity("unknown")).toBe(true);
  });

  test("rejects invalid values", () => {
    expect(isValidPolarity("maybe")).toBe(false);
    expect(isValidPolarity("")).toBe(false);
  });
});

describe("POLARITY_WEIGHT", () => {
  test("positive has highest weight", () => {
    expect(POLARITY_WEIGHT.positive).toBe(1);
  });

  test("negative has zero weight", () => {
    expect(POLARITY_WEIGHT.negative).toBe(0);
  });

  test("supportive has 0.8 weight", () => {
    expect(POLARITY_WEIGHT.supportive).toBe(0.8);
  });

  test("neutral and unknown have half weight", () => {
    expect(POLARITY_WEIGHT.neutral).toBe(0.5);
    expect(POLARITY_WEIGHT.unknown).toBe(0.5);
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

    const testCases = ["srov. rozhodnutí", "viz nález"];

    for (const text of testCases) {
      const matched = supportiveRules.some((r) =>
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
