import { describe, expect, test } from "bun:test";

import { createBoundedMemo } from "@/api/lib/legal-search/morphology/stem-memo";

/** Wide enough that the length ceiling is out of the way of the other tests. */
const KEY_LENGTH = 64;

/** A compute that records what it was asked for, so hits are observable. */
const counting = () => {
  const computed: string[] = [];
  return {
    computed,
    compute: (key: string) => () => {
      computed.push(key);
      return `${key}!`;
    },
  };
};

describe("bounded memo", () => {
  test("computes a key once and answers repeats from the memo", () => {
    const { computed, compute } = counting();
    const memo = createBoundedMemo({ maxEntries: 8, maxKeyLength: KEY_LENGTH });

    expect<string>(memo.get("a", compute("a"))).toBe("a!");
    expect<string>(memo.get("a", compute("a"))).toBe("a!");
    expect<string>(memo.get("b", compute("b"))).toBe("b!");

    expect<string[]>(computed).toEqual(["a", "b"]);
  });

  test("a key never answers with another key's value", () => {
    const memo = createBoundedMemo({ maxEntries: 4, maxKeyLength: KEY_LENGTH });
    const keys = Array.from({ length: 200 }, (_unused, index) => `k${index}`);

    for (const key of keys) {
      memo.get(key, () => `${key}!`);
    }

    // Read back in a different order than they were written, so a rotation
    // that mixed generations would surface here.
    for (const key of keys.toReversed()) {
      expect<string>(memo.get(key, () => `${key}!`)).toBe(`${key}!`);
    }
  });

  test("live entries stay within twice the generation ceiling", () => {
    const memo = createBoundedMemo({
      maxEntries: 10,
      maxKeyLength: KEY_LENGTH,
    });

    for (let index = 0; index < 500; index += 1) {
      memo.get(`k${index}`, () => `v${index}`);
      expect<number>(memo.size()).toBeLessThanOrEqual(20);
    }
  });

  test("a key still in use survives a rotation without recomputing", () => {
    const { computed, compute } = counting();
    const memo = createBoundedMemo({ maxEntries: 4, maxKeyLength: KEY_LENGTH });

    memo.get("hot", compute("hot"));
    // Fill past the ceiling twice over, touching "hot" once per generation so
    // it is promoted forward instead of aging out.
    for (let index = 0; index < 12; index += 1) {
      memo.get(`cold${index}`, compute(`cold${index}`));
      memo.get("hot", compute("hot"));
    }

    expect<string[]>(computed.filter((key) => key === "hot")).toEqual(["hot"]);
  });

  test("a key past the length ceiling is answered but never retained", () => {
    const { computed, compute } = counting();
    const memo = createBoundedMemo({ maxEntries: 1000, maxKeyLength: 8 });
    const oversized = "x".repeat(9);

    expect<string>(memo.get(oversized, compute(oversized))).toBe(
      `${oversized}!`,
    );
    expect<string>(memo.get(oversized, compute(oversized))).toBe(
      `${oversized}!`,
    );

    // Recomputed every time, and holding nothing: the entry ceiling alone
    // would have kept this key resident for the next 999 distinct terms.
    expect<number>(computed.length).toBe(2);
    expect<number>(memo.size()).toBe(0);
    // The key exactly at the ceiling is remembered, so the boundary is not
    // off by one in the direction that stops memoizing real terms.
    const atCeiling = "y".repeat(8);
    memo.get(atCeiling, compute(atCeiling));
    memo.get(atCeiling, compute(atCeiling));

    expect<number>(computed.filter((key) => key === atCeiling).length).toBe(1);
  });

  test("a key evicted with its generation is recomputed, not lost", () => {
    const { computed, compute } = counting();
    const memo = createBoundedMemo({ maxEntries: 2, maxKeyLength: KEY_LENGTH });

    memo.get("stale", compute("stale"));
    for (let index = 0; index < 20; index += 1) {
      memo.get(`other${index}`, compute(`other${index}`));
    }

    expect<string>(memo.get("stale", compute("stale"))).toBe("stale!");
    expect<number>(computed.filter((key) => key === "stale").length).toBe(2);
  });
});
