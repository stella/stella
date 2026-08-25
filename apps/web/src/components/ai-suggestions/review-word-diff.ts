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
  const lcsLengths = lcsLengthTable(a, b);
  return backtrack(a, b, lcsLengths);
};

const lcsLengthTable = (
  a: readonly string[],
  b: readonly string[],
): number[][] => {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
};

const backtrack = (
  a: readonly string[],
  b: readonly string[],
  lengths: readonly number[][],
): WordDiffOp[] => {
  const ops: WordDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ token: a[i], type: "equal" });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ token: a[i], type: "delete" });
      i++;
    } else {
      ops.push({ token: b[j], type: "insert" });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ token: a[i], type: "delete" });
    i++;
  }
  while (j < b.length) {
    ops.push({ token: b[j], type: "insert" });
    j++;
  }
  return ops;
};
