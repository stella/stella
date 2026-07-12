import { describe, expect, test } from "bun:test";

import {
  citationScore,
  courtWeight,
  courtWeightSql,
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

// Non-ASCII (Czech/Polish/German) regex source characters serialize as
// `\uXXXX` escapes via `RegExp.prototype.source` under the `u` flag —
// Postgres's ARE regex engine natively understands `\uwxyz`, so this is
// an equivalent (not broken) representation. Assertions below stick to
// ASCII-safe fragments (weights, structure) rather than matching the
// escaped accented text verbatim.
describe("courtWeightSql", () => {
  test("with no entries, falls back to the legacy hardcoded tiers (3 CZ/SK patterns)", () => {
    const generated = courtWeightSql("citing_d.court");
    expect(generated.match(/WHEN citing_d\.court ~\*/gu)).toHaveLength(3);
    expect(generated).toContain("THEN 4");
    expect(generated).toContain("THEN 3");
    expect(generated).toContain("THEN 2");
    expect(generated).toContain("ELSE 1 END");
  });

  test("with explicit undefined entries, falls back to the legacy tiers", () => {
    // Mirrors what callers pass when the DB-seeded table is empty
    // (loadCourtWeightEntriesForSql() resolves to undefined, not []).
    const withUndefined = courtWeightSql("citing_d.court", undefined);
    const withOmitted = courtWeightSql("citing_d.court");
    expect(withUndefined).toBe(withOmitted);
  });

  test("with DB-seeded entries, generates from those instead of the legacy tiers", () => {
    const generated = courtWeightSql("citing_d.court", [
      {
        pattern: /verfassungsgerichtshof/iu,
        tier: 4,
        tierLabel: "constitutional",
        weight: 10,
      },
      {
        pattern: /oberster gerichtshof/iu,
        tier: 3,
        tierLabel: "supreme",
        weight: 8,
      },
    ]);

    expect(generated).toContain("verfassungsgerichtshof");
    expect(generated).toContain("THEN 10");
    expect(generated).toContain("oberster gerichtshof");
    expect(generated).toContain("THEN 8");
    expect(generated.match(/WHEN citing_d\.court ~\*/gu)).toHaveLength(2);
    // The legacy CZ/SK-only tiers must not leak in alongside the seeded
    // entries (legacy tier 2's ASCII-safe fragment is distinctive).
    expect(generated).not.toContain("krajsk");
    expect(generated).toContain("ELSE 1 END");
  });

  test("an empty entries array does NOT fall back (documents the footgun that callers must avoid)", () => {
    // courtWeightSql only falls back on `undefined`/omitted entries; an
    // empty array is passed through verbatim. Callers that load from the
    // DB must convert an empty result to `undefined`
    // (see court-weights.test.ts: flattenCourtWeightEntries).
    const generated = courtWeightSql("citing_d.court", []);
    expect(generated).toBe("CASE \n      ELSE 1 END");
  });
});
