import { describe, expect, test } from "bun:test";

import {
  DECISION_RANKING_ARMS,
  minimumWordsHeld,
  rankedDecisionQuery,
} from "@/api/lib/legal-search/corpus-ranked-decision-query";

const WORDS = [
  {
    decisionLeaves: ['decision_terms:"loajalit"'],
    boostedLeaves: ['keywords:"loajalita"'],
  },
  { decisionLeaves: ['decision_terms:"škod"'], boostedLeaves: [] },
  {
    decisionLeaves: ['decision_terms:"zisk"', 'decision_terms:"ušl"'],
    boostedLeaves: [],
  },
] as const;

describe("how many words a decision must hold", () => {
  test.each([
    ["all", 11, 11],
    ["half", 11, 6],
    ["half", 10, 5],
    ["any", 11, 1],
    ["half", 1, 1],
  ] as const)("%s of %i words is %i", (arm, words, held) => {
    expect(minimumWordsHeld(arm, words)).toBe(held);
  });

  test("every arm asks for at least one word and at most all of them", () => {
    for (const arm of DECISION_RANKING_ARMS) {
      for (let words = 1; words <= 30; words += 1) {
        const held = minimumWordsHeld(arm, words);
        expect(held).toBeGreaterThanOrEqual(1);
        expect(held).toBeLessThanOrEqual(words);
      }
    }
  });

  test("a query with no word is refused", () => {
    expect(() => minimumWordsHeld("any", 0)).toThrow("at least one word");
  });
});

describe("the ranked decision query", () => {
  const query = rankedDecisionQuery({
    scope: 'is_opening:true AND jurisdiction:"CZE"',
    words: WORDS,
    arm: "half",
    boost: 2,
  });

  test("scope filters without scoring, and each word is one should clause", () => {
    expect<unknown>(query.bool.filter).toEqual([
      {
        query_string: {
          query: 'is_opening:true AND jurisdiction:"CZE"',
          default_operator: "AND",
          lenient: true,
        },
      },
    ]);
    expect(query.bool.should).toHaveLength(WORDS.length);
    expect(query.bool.minimum_should_match).toBe(2);
  });

  test("a word's publisher leaves carry the boost and count with its text leaves once", () => {
    expect<unknown>(query.bool.should.at(0)).toEqual({
      bool: {
        should: [
          {
            query_string: {
              query: '(decision_terms:"loajalit")',
              default_operator: "AND",
            },
          },
          {
            query_string: {
              query: '(keywords:"loajalita")',
              default_operator: "AND",
              boost: 2,
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
    expect<unknown>(query.bool.should.at(2)).toEqual({
      query_string: {
        query: '(decision_terms:"zisk" OR decision_terms:"ušl")',
        default_operator: "AND",
      },
    });
  });

  test("the scope never enters a should clause", () => {
    expect(JSON.stringify(query.bool.should)).not.toContain("jurisdiction");
  });

  test("a boost that would invert or erase the publisher leaves is refused", () => {
    for (const boost of [0, -1, Number.NaN]) {
      expect(() =>
        rankedDecisionQuery({ scope: "*", words: WORDS, arm: "any", boost }),
      ).toThrow("positive number");
    }
  });
});
