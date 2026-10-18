import { describe, expect, test } from "bun:test";

import { SEARCH_PAGINATION_COMPLETE } from "@stll/api-contract/search";

import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import { runTwoPhaseSearch } from "@/api/lib/legal-search/two-phase-search";

const fingerprint = "a".repeat(64);
const generation = "case_law_v7";
const boundary = {
  id: "00000000-0000-0000-0000-000000000001",
  score: 0.5,
  sort: "relevance" as const,
  windowStart: 0,
};
type Hit = { id: string; coverage: number; score: number };
const hit = (id: string, coverage: number, score: number): Hit => ({
  id,
  coverage,
  score,
});
const page = (hits: readonly Hit[], nextCursor = null) => ({
  hits,
  nextCursor,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
});

const run = async ({
  strict,
  relaxed,
  strictOnly = false,
  cursor = null,
  atStart = true,
}: {
  strict: ReturnType<typeof page>;
  relaxed: ReturnType<typeof page>;
  strictOnly?: boolean;
  cursor?: ReturnType<typeof decodeCorpusSearchCursor>;
  atStart?: boolean;
}) => {
  const phases: string[] = [];
  const result = await runTwoPhaseSearch({
    atStart,
    cursor,
    fingerprint,
    generation,
    limit: 3,
    strictOnly,
    read: async (phase) => {
      phases.push(phase.type);
      return await Promise.resolve(phase.type === "strict" ? strict : relaxed);
    },
    encodeCursor: (value, phase) =>
      value.nextCursor === null
        ? null
        : encodeCorpusSearchCursor({
            ...value.nextCursor,
            dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
            target: null,
            phase,
          }),
    groupToken: ({ id }) => id.padEnd(6, "0").slice(0, 6),
    hitId: ({ id }) => id,
  });
  return { phases, result };
};

describe("two-phase corpus search", () => {
  test("does not read relaxed results when the strict page is full", async () => {
    const { phases } = await run({
      strict: page([hit("a", 3, 1), hit("b", 3, 1), hit("c", 3, 1)]),
      relaxed: page([]),
    });
    expect(phases).toEqual(["strict"]);
  });

  test("appends unique relaxed hits in the engine's order", async () => {
    const { result } = await run({
      strict: page([hit("a", 3, 1)]),
      relaxed: page([
        hit("a", 3, 99),
        hit("b", 1, 9),
        hit("c", 2, 5),
        hit("d", 2, 2),
      ]),
    });
    expect(result.hits.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(result.relaxedShown).toBe(true);
  });

  test("a later strict page never tops up, so earlier strict hits cannot return", async () => {
    // Four strict matches read at offset 3 with limit 3: the page holds only
    // the fourth. Topping it up would read the relaxed phase, which knows
    // nothing of the three matches page one showed.
    const { phases, result } = await run({
      strict: page([hit("d", 3, 1)]),
      relaxed: page([hit("a", 3, 9), hit("b", 3, 8), hit("c", 3, 7)]),
      atStart: false,
    });
    expect(phases).toEqual(["strict"]);
    expect(result.hits.map(({ id }) => id)).toEqual(["d"]);
    expect(result.relaxedShown).toBe(false);
  });

  test("the first relaxed page and its continuation keep one order", async () => {
    // Scores fall across the two pages while word coverage does not: no page
    // re-ranks, so the order a reader sees is the order the cursor continues.
    const first = await run({
      strict: page([], null),
      relaxed: page([hit("b", 1, 9), hit("c", 3, 8), hit("d", 2, 7)], boundary),
    });
    expect(first.result.hits.map(({ id }) => id)).toEqual(["b", "c", "d"]);
    const cursor = decodeCorpusSearchCursor(first.result.nextCursor ?? "");
    const resumed = await run({
      strict: page([]),
      relaxed: page([hit("e", 3, 6), hit("f", 1, 5)]),
      cursor,
    });
    expect(resumed.result.hits.map(({ id }) => id)).toEqual(["e", "f"]);
  });

  test("strict mode never reads the relaxed phase", async () => {
    const { phases } = await run({
      strict: page([]),
      relaxed: page([hit("b", 1, 1)]),
      strictOnly: true,
    });
    expect(phases).toEqual(["strict"]);
  });

  test("a relaxed cursor round-trips and resumes only that phase", async () => {
    const first = await run({
      strict: page([], null),
      relaxed: page([hit("b", 1, 1)], boundary),
    });
    const cursor = decodeCorpusSearchCursor(first.result.nextCursor ?? "");
    expect(cursor?.phase?.type).toBe("relaxed");
    const resumed = await run({
      strict: page([hit("wrong", 3, 3)]),
      relaxed: page([hit("c", 1, 1)]),
      cursor,
    });
    expect(resumed.phases).toEqual(["relaxed"]);
    expect(resumed.result.hits.map(({ id }) => id)).toEqual(["c"]);
  });
});
