import { panic } from "better-result";

import { AhoCorasick } from "@stll/aho-corasick";

const LITERAL_MATCHER_CACHE_LIMIT = 64;
const matchers = new Map<string, AhoCorasick>();

/** Reuse compiled citation literals without retaining an unbounded quote history. */
export const caseLawLiteralMatcher = (quote: string) => {
  const literal = quote.toWellFormed();
  if (literal.length === 0) {
    return panic("A citation literal matcher requires a nonempty quote");
  }
  const cached = matchers.get(literal);
  if (cached !== undefined) {
    return cached;
  }
  const matcher = new AhoCorasick([literal]);
  if (matchers.size === LITERAL_MATCHER_CACHE_LIMIT) {
    const oldest = matchers.keys().next().value;
    if (oldest === undefined) {
      return panic("A full literal matcher cache has no oldest entry");
    }
    matchers.delete(oldest);
  }
  matchers.set(literal, matcher);
  return matcher;
};
