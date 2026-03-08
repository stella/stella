import { describe, expect, test } from "bun:test";

import {
  citationScore,
  courtWeight,
  recencyFactor,
  weightedCitationSum,
} from "@/api/handlers/case-law/citation-score";

describe("courtWeight", () => {
  test("constitutional court → tier 4", () => {
    expect(courtWeight("Ústavní soud")).toBe(4);
  });

  test("slovak constitutional court → tier 4", () => {
    expect(courtWeight("Ústavný súd SR")).toBe(4);
  });

  test("supreme court → tier 3", () => {
    expect(courtWeight("Nejvyšší soud")).toBe(3);
  });

  test("supreme admin court → tier 3", () => {
    expect(courtWeight("Nejvyšší správní soud")).toBe(3);
  });

  test("slovak supreme court → tier 3", () => {
    expect(courtWeight("Najvyšší súd SR")).toBe(3);
  });

  test("regional court → tier 2", () => {
    expect(courtWeight("Krajský soud v Brně")).toBe(2);
  });

  test("municipal court → tier 2", () => {
    expect(courtWeight("Městský soud v Praze")).toBe(2);
  });

  test("high court → tier 2", () => {
    expect(courtWeight("Vrchní soud v Praze")).toBe(2);
  });

  test("district court → tier 1 (default)", () => {
    expect(courtWeight("Okresní soud v Ostravě")).toBe(1);
  });

  test("unknown court → tier 1 (default)", () => {
    expect(courtWeight("Random Court")).toBe(1);
  });

  test("case insensitive matching", () => {
    expect(courtWeight("ÚSTAVNÍ SOUD")).toBe(4);
    expect(courtWeight("nejvyšší soud")).toBe(3);
  });
});

describe("recencyFactor", () => {
  const now = new Date("2025-01-01");

  test("today → factor ~1", () => {
    const f = recencyFactor("2025-01-01", now);
    expect(f).toBeCloseTo(1, 1);
  });

  test("1 year ago → factor ~0.5", () => {
    const f = recencyFactor("2024-01-01", now);
    expect(f).toBeCloseTo(0.5, 1);
  });

  test("10 years ago → factor ~0.09", () => {
    const f = recencyFactor("2015-01-01", now);
    expect(f).toBeLessThan(0.15);
    expect(f).toBeGreaterThan(0.05);
  });

  test("null date → 0.5 (half weight)", () => {
    expect(recencyFactor(null, now)).toBe(0.5);
  });

  test("future date → clamped to 1", () => {
    const f = recencyFactor("2026-01-01", now);
    expect(f).toBeCloseTo(1, 0);
  });

  test("accepts Date objects", () => {
    const d = new Date("2024-01-01");
    const f = recencyFactor(d, now);
    expect(f).toBeCloseTo(0.5, 1);
  });
});

describe("weightedCitationSum", () => {
  const now = new Date("2025-01-01");

  test("empty citations → 0", () => {
    expect(weightedCitationSum([], now)).toBe(0);
  });

  test("single recent supreme citation", () => {
    const sum = weightedCitationSum(
      [
        {
          citingCourt: "Nejvyšší soud",
          citingDate: "2025-01-01",
        },
      ],
      now,
    );
    // courtWeight=3, recency≈1 → ~3
    expect(sum).toBeCloseTo(3, 0);
  });

  test("accumulates multiple citations", () => {
    const sum = weightedCitationSum(
      [
        {
          citingCourt: "Nejvyšší soud",
          citingDate: "2025-01-01",
        },
        {
          citingCourt: "Krajský soud v Brně",
          citingDate: "2024-01-01",
        },
      ],
      now,
    );
    // 3*1 + 2*0.5 = 4
    expect(sum).toBeCloseTo(4, 0);
  });
});

describe("citationScore", () => {
  const now = new Date("2025-01-01");

  test("no citations → 0", () => {
    expect(citationScore([], "2020-01-01", now)).toBe(0);
  });

  test("positive with citations", () => {
    const score = citationScore(
      [
        {
          citingCourt: "Nejvyšší soud",
          citingDate: "2024-06-01",
        },
      ],
      "2020-01-01",
      now,
    );
    expect(score).toBeGreaterThan(0);
  });

  test("log-compressed: 100 citations < 10x of 10", () => {
    const makeCitations = (n: number) =>
      Array.from({ length: n }, () => ({
        citingCourt: "Krajský soud v Brně",
        citingDate: "2024-06-01",
      }));

    const ten = citationScore(makeCitations(10), "2015-01-01", now);
    const hundred = citationScore(makeCitations(100), "2015-01-01", now);

    expect(hundred).toBeGreaterThan(ten);
    expect(hundred / ten).toBeLessThan(4);
  });

  test("density: recent few citations beat old many", () => {
    // 2024 decision with 5 recent supreme citations
    const recent = citationScore(
      Array.from({ length: 5 }, () => ({
        citingCourt: "Nejvyšší soud",
        citingDate: "2025-06-01",
      })),
      "2024-01-01",
      now,
    );

    // 2000 decision with 20 old district citations
    const old = citationScore(
      Array.from({ length: 20 }, () => ({
        citingCourt: "Okresní soud v Ostravě",
        citingDate: "2005-01-01",
      })),
      "2000-01-01",
      now,
    );

    expect(recent).toBeGreaterThan(old);
  });

  test("null decision date → yearsOld defaults to 1", () => {
    const score = citationScore(
      [
        {
          citingCourt: "Nejvyšší soud",
          citingDate: "2024-06-01",
        },
      ],
      null,
      now,
    );
    expect(score).toBeGreaterThan(0);
  });
});
