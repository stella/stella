import { describe, expect, test } from "bun:test";

import { createBoundedMemo } from "@/api/lib/legal-search/morphology/stem-memo";

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
    const memo = createBoundedMemo(8);

    expect<string>(memo.get("a", compute("a"))).toBe("a!");
    expect<string>(memo.get("a", compute("a"))).toBe("a!");
    expect<string>(memo.get("b", compute("b"))).toBe("b!");

    expect<string[]>(computed).toEqual(["a", "b"]);
  });

  test("a key never answers with another key's value", () => {
    const memo = createBoundedMemo(4);
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
    const memo = createBoundedMemo(10);

    for (let index = 0; index < 500; index += 1) {
      memo.get(`k${index}`, () => `v${index}`);
      expect<number>(memo.size()).toBeLessThanOrEqual(20);
    }
  });

  test("a key still in use survives a rotation without recomputing", () => {
    const { computed, compute } = counting();
    const memo = createBoundedMemo(4);

    memo.get("hot", compute("hot"));
    // Fill past the ceiling twice over, touching "hot" once per generation so
    // it is promoted forward instead of aging out.
    for (let index = 0; index < 12; index += 1) {
      memo.get(`cold${index}`, compute(`cold${index}`));
      memo.get("hot", compute("hot"));
    }

    expect<string[]>(computed.filter((key) => key === "hot")).toEqual(["hot"]);
  });

  test("a key evicted with its generation is recomputed, not lost", () => {
    const { computed, compute } = counting();
    const memo = createBoundedMemo(2);

    memo.get("stale", compute("stale"));
    for (let index = 0; index < 20; index += 1) {
      memo.get(`other${index}`, compute(`other${index}`));
    }

    expect<string>(memo.get("stale", compute("stale"))).toBe("stale!");
    expect<number>(computed.filter((key) => key === "stale").length).toBe(2);
  });
});
