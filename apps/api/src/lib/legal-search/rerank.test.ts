import { expect, test } from "bun:test";

import {
  blendCitationAuthority,
  rrfMerge,
  type ScoredCandidate,
} from "@/api/lib/legal-search/rerank";

const authority = (entries: Record<string, number>): Map<string, number> =>
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
