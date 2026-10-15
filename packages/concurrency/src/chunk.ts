import { panic } from "better-result";

/** Consecutive batches of at most `size`, preserving input order. */
export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  // Invalid sizes cannot define disjoint, advancing batches.
  if (!Number.isSafeInteger(size) || size < 1) {
    panic("Chunk size must be a positive safe integer");
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};
