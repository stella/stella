/**
 * Compute the Levenshtein edit distance between two
 * strings. O(n*m) time, O(min(n,m)) space using a
 * single-row DP approach.
 */
export const levenshtein = (rawA: string, rawB: string): number => {
  if (rawA === rawB) {
    return 0;
  }
  if (rawA.length === 0) {
    return rawB.length;
  }
  if (rawB.length === 0) {
    return rawA.length;
  }

  const [shorter, longer] =
    rawA.length <= rawB.length ? [rawA, rawB] : [rawB, rawA];

  const aLen = shorter.length;
  const bLen = longer.length;
  const row = new Uint16Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) {
    row[i] = i;
  }

  for (let j = 1; j <= bLen; j++) {
    let prev = row[0] ?? 0;
    row[0] = j;

    for (let i = 1; i <= aLen; i++) {
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      const temp = row[i] ?? 0;
      row[i] = Math.min((row[i] ?? 0) + 1, (row[i - 1] ?? 0) + 1, prev + cost);
      prev = temp;
    }
  }

  return row[aLen] ?? 0;
};
