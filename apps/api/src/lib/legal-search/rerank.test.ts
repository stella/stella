import { expect, test } from "bun:test";

import {
  AUTHORITY_PIVOT,
  blendCitationAuthority,
  blendStableCitationAuthority,
  courtTierSignal,
  courtTierValue,
  DEFAULT_AUTHORITY_WEIGHT,
  DEFAULT_COURT_TIER_WEIGHT,
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
  rrfMerge,
  saturateAuthority,
  stableBlendUpperBound,
  type ScoredCandidate,
} from "@/api/lib/legal-search/rerank";

const authority = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

const tiers = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

test("equal lexical score → higher citation authority ranks first", () => {
  const candidates: ScoredCandidate[] = [
    { id: "a", score: 5 },
    { id: "b", score: 5 },
  ];
  const ranked = blendCitationAuthority({
    candidates,
    authorityById: authority({ a: 0.1, b: 0.9 }),
  });
  expect(ranked.map((h) => h.id)).toEqual(["b", "a"]);
});

test("higher lexical score wins when authority is equal", () => {
  const candidates: ScoredCandidate[] = [
    { id: "low", score: 1 },
    { id: "high", score: 100 },
  ];
  const ranked = blendCitationAuthority({
    candidates,
    authorityById: authority({ low: 0.5, high: 0.5 }),
  });
  expect(ranked.at(0)?.id).toBe("high");
});

test("weight 0 reduces to pure lexical ordering", () => {
  const candidates: ScoredCandidate[] = [
    { id: "a", score: 3 },
    { id: "b", score: 9 },
    { id: "c", score: 6 },
  ];
  const ranked = blendCitationAuthority({
    candidates,
    authorityById: authority({ a: 1, b: 0, c: 0 }),
    weight: 0,
  });
  expect(ranked.map((h) => h.id)).toEqual(["b", "c", "a"]);
});

test("raising a candidate's authority never lowers its rank (monotonic)", () => {
  const candidates: ScoredCandidate[] = [
    { id: "a", score: 5 },
    { id: "b", score: 6 },
    { id: "c", score: 4 },
  ];
  const rankOf = (auth: Map<string, number>): number =>
    blendCitationAuthority({ candidates, authorityById: auth }).findIndex(
      (h) => h.id === "a",
    );

  const before = rankOf(authority({ a: 0.1, b: 0.5, c: 0.5 }));
  const after = rankOf(authority({ a: 0.95, b: 0.5, c: 0.5 }));
  // Lower index = higher rank. More authority must not push it down.
  expect(after).toBeLessThanOrEqual(before);
});

test("ties break deterministically by id (descending), for cursor stability", () => {
  const candidates: ScoredCandidate[] = [
    { id: "aaa", score: 5 },
    { id: "zzz", score: 5 },
  ];
  const ranked = blendCitationAuthority({
    candidates,
    authorityById: authority({ aaa: 0.5, zzz: 0.5 }),
  });
  // Equal lexical + equal authority → identical blended score → id desc.
  expect(ranked.map((h) => h.id)).toEqual(["zzz", "aaa"]);
});

test("empty candidate set yields no hits", () => {
  expect(
    blendCitationAuthority({ candidates: [], authorityById: authority({}) }),
  ).toEqual([]);
});

test("stable blend keeps cursor scores unchanged when later windows are appended", () => {
  const firstWindow: ScoredCandidate[] = [
    { id: "a", score: 1 },
    { id: "b", score: 0.9 },
  ];
  const secondWindow: ScoredCandidate[] = [
    ...firstWindow,
    { id: "c", score: 0.8 },
  ];

  const firstScore = blendStableCitationAuthority({
    candidates: firstWindow,
    authorityById: authority({ a: 0.2, b: 0.1, c: 3 }),
  }).find((hit) => hit.id === "a")?.score;
  const scoreAfterAppend = blendStableCitationAuthority({
    candidates: secondWindow,
    authorityById: authority({ a: 0.2, b: 0.1, c: 3 }),
  }).find((hit) => hit.id === "a")?.score;

  expect(scoreAfterAppend).toBe(firstScore);
});

test("rrfMerge: appearing high in multiple lists beats a single-list top hit", () => {
  // `shared` is #2 in both lists; `solo` is #1 in one list only.
  const listA: ScoredCandidate[] = [
    { id: "solo", score: 10 },
    { id: "shared", score: 9 },
  ];
  const listB: ScoredCandidate[] = [
    { id: "other", score: 10 },
    { id: "shared", score: 9 },
  ];
  const fused = rrfMerge([listA, listB]);
  expect((fused.get("shared") ?? 0) > (fused.get("solo") ?? 0)).toBe(true);
});

test("rrfMerge feeds blendCitationAuthority as the lexical signal", () => {
  const fused = rrfMerge([
    [
      { id: "x", score: 1 },
      { id: "y", score: 1 },
    ],
    [{ id: "y", score: 1 }],
  ]);
  const candidates: ScoredCandidate[] = [...fused].map(([id, score]) => ({
    id,
    score,
  }));
  const ranked = blendCitationAuthority({
    candidates,
    authorityById: authority({ x: 0, y: 0 }),
  });
  // y is fused from both lists, so it must outrank x on lexical alone.
  expect(ranked.at(0)?.id).toBe("y");
});

test("saturation is bounded, monotone, and half-saturated at the pivot", () => {
  expect(saturateAuthority(0)).toBe(0);
  expect(saturateAuthority(AUTHORITY_PIVOT)).toBe(0.5);
  // Bounded below 1 however authoritative the decision, which is what lets
  // the pagination bound be the signal weights alone.
  expect(saturateAuthority(1e6)).toBeLessThan(1);
  expect(saturateAuthority(1e6)).toBeGreaterThan(0.999);
  // A corrupt negative value cannot invert the signal.
  expect(saturateAuthority(-5)).toBe(0);

  const sampled = [0, 0.25, 0.5, 1, 2, 5, 12, 40].map(saturateAuthority);
  for (const [i, value] of sampled.entries()) {
    if (i > 0) {
      expect(value).toBeGreaterThan(sampled[i - 1] ?? 0);
    }
  }
});

test("the stable blend adds the saturated authority, not the raw value", () => {
  const [hit] = blendStableCitationAuthority({
    candidates: [{ id: "a", score: 2 }],
    authorityById: authority({ a: 5 }),
    weight: 0.3,
  });
  // 5 / (5 + 1) = 0.8333…, so the blend adds 0.25 — the raw value would add
  // 1.5 and swamp the lexical score it is meant to nudge.
  expect(hit?.score).toBeCloseTo(2 + 0.3 * (5 / 6), 12);
  // The hit still reports the raw column value.
  expect(hit?.citationAuthority).toBe(5);
});

test("a candidate's authority contribution does not depend on the page it lands on", () => {
  // Equal lexical scores, so min-max collapses the lexical side to 0 and what
  // is left is the authority contribution alone.
  const contributionOf = (candidates: ScoredCandidate[]): number =>
    blendCitationAuthority({
      candidates,
      authorityById: authority({ a: 1, b: 0.2, c: 40 }),
      weight: 0.3,
    }).find((hit) => hit.id === "a")?.score ?? Number.NaN;

  const alone = contributionOf([
    { id: "a", score: 5 },
    { id: "b", score: 5 },
  ]);
  const besideALandmark = contributionOf([
    { id: "a", score: 5 },
    { id: "b", score: 5 },
    { id: "c", score: 5 },
  ]);

  expect(alone).toBeCloseTo(0.3 * saturateAuthority(1), 12);
  expect(besideALandmark).toBe(alone);
});

test("the pagination bound is the next lexical score plus the whole weight", () => {
  expect(stableBlendUpperBound(1.5, 0.3)).toBeCloseTo(1.8, 12);
  // No unseen candidate can reach past it: saturation is strictly below 1.
  const blended = blendStableCitationAuthority({
    candidates: [{ id: "a", score: 1.5 }],
    authorityById: authority({ a: 1e9 }),
    weight: 0.3,
  });
  expect(blended.at(0)?.score).toBeLessThan(stableBlendUpperBound(1.5, 0.3));
  // And it defaults to the same weight the blends default to.
  expect(stableBlendUpperBound(1.5)).toBe(stableBlendUpperBound(1.5, 0.3));
});

test("the pagination bound covers every signal the blend was given", () => {
  const bothWeights = DEFAULT_AUTHORITY_WEIGHT + DEFAULT_COURT_TIER_WEIGHT;

  // The most a candidate can be worth: an apex court, cited without end. It
  // still lands under the summed weight, which is what lets a scan stop early.
  const blended = blendStableCitationAuthority({
    candidates: [{ id: "apex", score: 1.5 }],
    authorityById: authority({ apex: 1e9 }),
    signals: [courtTierSignal(tiers({ apex: HIGHEST_COURT_TIER }))],
  });
  expect(blended.at(0)?.score).toBeLessThan(
    stableBlendUpperBound(1.5, bothWeights),
  );
  // And past the bound that counts authority alone, which is the bug a bound
  // narrower than its blend would cause.
  expect(blended.at(0)?.score).toBeGreaterThan(stableBlendUpperBound(1.5));
});

test("a signal weight the bound cannot account for is a panic, not a score", () => {
  const blendWith = (weight: number) =>
    blendStableCitationAuthority({
      candidates: [{ id: "a", score: 1 }],
      authorityById: authority({}),
      signals: [{ name: "broken", weight, valueFor: () => 1 }],
    });

  // A negative weight subtracts from a score the pagination bound assumes it
  // can only add to, so an unseen candidate could outrank an emitted page.
  expect(() => blendWith(-0.1)).toThrow(
    "Blend signal broken weighs -0.1, which is not a finite non-negative number",
  );
  expect(() => blendWith(Number.NaN)).toThrow("Blend signal broken weighs NaN");
  expect(() => blendWith(Number.POSITIVE_INFINITY)).toThrow(
    "Blend signal broken weighs Infinity",
  );
  // Zero contributes nothing and breaks nothing.
  expect(blendWith(0).at(0)?.score).toBe(1);
});

test("court tier spans [0, 1] from the default tier to an apex court", () => {
  expect(courtTierValue(LOWEST_COURT_TIER)).toBe(0);
  expect(courtTierValue(HIGHEST_COURT_TIER)).toBe(1);
  // Evenly spaced, and clamped outside the registry's range so no row can
  // push a signal value past the bound.
  expect(courtTierValue(2)).toBeCloseTo(1 / 3, 12);
  expect(courtTierValue(3)).toBeCloseTo(2 / 3, 12);
  expect(courtTierValue(0)).toBe(0);
  expect(courtTierValue(99)).toBe(1);
});

test("an uncited apex decision outranks a cited district one at equal lexical score", () => {
  const candidates: ScoredCandidate[] = [
    { id: "apex-fresh", score: 0.5 },
    { id: "district-cited", score: 0.5 },
  ];
  const ranked = blendStableCitationAuthority({
    candidates,
    authorityById: authority({ "apex-fresh": 0, "district-cited": 1 }),
    signals: [
      courtTierSignal(
        tiers({
          "apex-fresh": HIGHEST_COURT_TIER,
          "district-cited": LOWEST_COURT_TIER,
        }),
      ),
    ],
  });
  expect(ranked.map((hit) => hit.id)).toEqual(["apex-fresh", "district-cited"]);
});

test("a stronger lexical match still outranks the apex court", () => {
  const ranked = blendStableCitationAuthority({
    candidates: [
      { id: "apex", score: 0.5 },
      { id: "on-point", score: 0.9 },
    ],
    authorityById: authority({}),
    signals: [courtTierSignal(tiers({ apex: HIGHEST_COURT_TIER }))],
  });
  // 0.9 beats 0.5 + 0.2: a lexical gap wider than the tier weight holds.
  expect(ranked.at(0)?.id).toBe("on-point");
});

test("the same inputs rank in the same order however the candidates arrive", () => {
  const candidates: ScoredCandidate[] = [
    { id: "a", score: 0.6 },
    { id: "b", score: 0.6 },
    { id: "c", score: 0.4 },
    { id: "d", score: 0.4 },
  ];
  const authorityById = authority({ a: 0, b: 0, c: 2, d: 2 });
  const courtTierById = tiers({ a: 3, b: 3, c: 1, d: 4 });
  const rank = (input: readonly ScoredCandidate[]): string[] =>
    blendStableCitationAuthority({
      candidates: input,
      authorityById,
      signals: [courtTierSignal(courtTierById)],
    }).map((hit) => hit.id);

  const order = rank(candidates);
  expect(rank(candidates.toReversed())).toEqual(order);
  expect(rank(candidates)).toEqual(order);
});
