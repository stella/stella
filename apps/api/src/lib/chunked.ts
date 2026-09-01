/**
 * Split `items` into consecutive batches of at most `size`. Bulk INSERTs use
 * it to stay under PostgreSQL's bind-parameter cap: one statement can carry
 * at most 65,535 placeholders, so a row set with no natural upper bound must
 * be written in batches.
 */
export const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};
