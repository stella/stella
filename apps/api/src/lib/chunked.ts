import { panic } from "better-result";

/**
 * Split `items` into consecutive batches of at most `size`. Bulk INSERTs use
 * it to stay under PostgreSQL's bind-parameter cap: one statement can carry
 * at most 65,535 placeholders, so a row set with no natural upper bound must
 * be written in batches.
 */
export const chunked = <T>(items: readonly T[], size: number): T[][] => {
  // A non-positive or non-integer size never advances `index`, so the loop
  // below would spin forever or drop items; every caller passes a named
  // constant, which makes anything else programmer error.
  if (!Number.isSafeInteger(size) || size < 1) {
    panic("Chunk size must be a positive safe integer");
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};
