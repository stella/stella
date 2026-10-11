/**
 * Tiny word-level LCS differ for the aligned-pair language view. Tokens are
 * words and whitespace runs, so equal spacing collapses into "equal" ops and
 * only wording changes surface as insert/delete.
 */

export type WordDiffOp = { type: "equal" | "insert" | "delete"; token: string };

const tokenize = (text: string): string[] =>
  text.split(/(\s+)/u).filter((token) => token.length > 0);

/** Diffs `before` (standard wording) against `after` (target wording). */
export const diffWords = (before: string, after: string): WordDiffOp[] => {
  const a = tokenize(before);
  const b = tokenize(after);
  return backtrack(a, b, lcsLengthTable(a, b));
};

/**
 * The LCS of two suffixes, or 0 past either end — which is the base case, not
 * a fallback: the longest common subsequence of an empty suffix is empty. That
 * makes the reads past the table's edge exact rather than defensive.
 */
const cellAt = (
  table: readonly (readonly number[])[],
  i: number,
  j: number,
): number => table[i]?.[j] ?? 0;

const lcsLengthTable = (
  a: readonly string[],
  b: readonly string[],
): number[][] => {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i];
    if (row === undefined) {
      continue;
    }
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? cellAt(table, i + 1, j + 1) + 1
          : Math.max(cellAt(table, i + 1, j), cellAt(table, i, j + 1));
    }
  }
  return table;
};

const backtrack = (
  a: readonly string[],
  b: readonly string[],
  lengths: readonly (readonly number[])[],
): WordDiffOp[] => {
  const ops: WordDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const tokenA = a[i];
    const tokenB = b[j];
    if (tokenA === undefined || tokenB === undefined) {
      break;
    }
    if (tokenA === tokenB) {
      ops.push({ token: tokenA, type: "equal" });
      i++;
      j++;
      continue;
    }
    if (cellAt(lengths, i + 1, j) >= cellAt(lengths, i, j + 1)) {
      ops.push({ token: tokenA, type: "delete" });
      i++;
      continue;
    }
    ops.push({ token: tokenB, type: "insert" });
    j++;
  }
  for (const token of a.slice(i)) {
    ops.push({ token, type: "delete" });
  }
  for (const token of b.slice(j)) {
    ops.push({ token, type: "insert" });
  }
  return ops;
};
