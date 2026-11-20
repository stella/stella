import { panic } from "better-result";

/**
 * The ranked decision query: one engine request that orders decisions by how
 * well their whole text matches the words, as ES `bool` DSL.
 *
 * Why DSL rather than the query string every other read sends: a query
 * string scores every clause it holds, so a scope clause (jurisdiction,
 * source exclusions, the opening passage) adds an idf constant to `_score`
 * that differs per split, and a blend reading BM25 values reads that as
 * relevance. Here scope sits in `filter`, which matches without scoring, and
 * each word is one `should` clause, so `minimum_should_match` says how many
 * of the words a decision must hold. One request shape serves every arm:
 *
 * - `all`: every word (what `strict` asks for), an intersection;
 * - `half`: at least half of them, rounded up;
 * - `any`: at least one, ranked by how many and how rare.
 *
 * A word's clause is its own disjunction: its leaves on the decision-level
 * field (typed form, stem, legal alternatives), and optionally its leaves on
 * the publisher's keywords and headnote, which carry a `boost` so a word the
 * publisher named for the decision weighs more than one in its text. Either
 * way the word counts once toward `minimum_should_match`.
 */

export const DECISION_RANKING_ARMS = ["all", "half", "any"] as const;

export type DecisionRankingArm = (typeof DECISION_RANKING_ARMS)[number];

/** One query word as engine leaves, each already field-qualified. */
export type RankedDecisionWord = {
  /** Leaves on the decision-level field; at least one. */
  decisionLeaves: readonly string[];
  /** Leaves on publisher fields that carry `boost`; may be empty. */
  boostedLeaves: readonly string[];
};

/** How many words a decision must hold under an arm. */
export const minimumWordsHeld = (
  arm: DecisionRankingArm,
  wordCount: number,
): number => {
  if (!Number.isSafeInteger(wordCount) || wordCount < 1) {
    return panic("A ranked decision query needs at least one word");
  }
  switch (arm) {
    case "all":
      return wordCount;
    case "half":
      return Math.ceil(wordCount / 2);
    case "any":
      return 1;
    default:
      arm satisfies never;
      return panic("Unhandled decision ranking arm");
  }
};

type RankedDecisionQueryOptions = {
  /** Every clause that scopes without scoring, as one query string. */
  scope: string;
  words: readonly RankedDecisionWord[];
  arm: DecisionRankingArm;
  /** Weight of the publisher leaves relative to the decision text. */
  boost: number;
};

const queryString = (query: string, extra: Record<string, unknown> = {}) => ({
  query_string: { query, default_operator: "AND", ...extra },
});

const wordClause = (
  { decisionLeaves, boostedLeaves }: RankedDecisionWord,
  boost: number,
) => {
  if (decisionLeaves.length === 0) {
    return panic("A ranked word needs a leaf on the decision field");
  }
  const decision = queryString(`(${decisionLeaves.join(" OR ")})`);
  return boostedLeaves.length === 0
    ? decision
    : {
        bool: {
          should: [
            decision,
            queryString(`(${boostedLeaves.join(" OR ")})`, { boost }),
          ],
          minimum_should_match: 1,
        },
      };
};

/** The `query` member of a ranked decision request. */
export const rankedDecisionQuery = ({
  scope,
  words,
  arm,
  boost,
}: RankedDecisionQueryOptions) => {
  if (!Number.isFinite(boost) || boost <= 0) {
    return panic("A publisher-field boost must be a positive number");
  }
  return {
    bool: {
      // `lenient` as on the filtered aggregation: a scope clause naming a
      // field one index of a multi-index read lacks matches nothing there.
      filter: [queryString(scope, { lenient: true })],
      should: words.map((word) => wordClause(word, boost)),
      minimum_should_match: minimumWordsHeld(arm, words.length),
    },
  };
};
