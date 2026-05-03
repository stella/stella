/**
 * Word-level diff between two strings. Tokenises on whitespace
 * boundaries (preserving the whitespace as part of each token), runs
 * an LCS, and returns a left-to-right ordered list of segments where
 * shared runs render as `equal`, removed runs as `del`, and added
 * runs as `ins`. Used by both the panel (to render minimal-change
 * redlines) and the apply engine (so tracked changes only mark the
 * divergent tokens, not the whole replaced span).
 *
 * O(n*m) on token counts; if a single replacement ever holds more
 * than a few hundred tokens, swap for a streaming diff.
 */
export type WordDiffSegment = {
  type: "equal" | "del" | "ins";
  text: string;
};

const tokenize = (s: string): string[] => s.match(/\s+|\S+/g) ?? [];

export const diffWordSegments = (
  before: string,
  after: string,
): WordDiffSegment[] => {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length === 0 && b.length === 0) {
    return [];
  }
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const row = dp[i + 1];
      const prevRow = dp[i];
      if (!row || !prevRow) {
        continue;
      }
      const prev = prevRow[j] ?? 0;
      const left = row[j] ?? 0;
      const top = prevRow[j + 1] ?? 0;
      row[j + 1] = a[i] === b[j] ? prev + 1 : Math.max(left, top);
    }
  }
  const segments: WordDiffSegment[] = [];
  const push = (type: WordDiffSegment["type"], text: string) => {
    if (text.length === 0) {
      return;
    }
    const last = segments.at(-1);
    if (last && last.type === type) {
      last.text += text;
      return;
    }
    segments.push({ type, text });
  };
  let i = m;
  let j = n;
  const reverse: WordDiffSegment[] = [];
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      reverse.push({ type: "equal", text: a[i - 1] ?? "" });
      i--;
      j--;
      continue;
    }
    const top = dp[i - 1]?.[j] ?? 0;
    const left = dp[i]?.[j - 1] ?? 0;
    // Backtracking emits in reverse, so pushing `ins` first here
    // makes `del` come BEFORE `ins` in the final left-to-right
    // output. That ordering matters at apply time: the inserted
    // text lands after the deletion-marked span, matching reader
    // convention (strike-through → new text) and matching the
    // engine's existing test expectation ("shallmust", not
    // "mustshall").
    if (top > left) {
      reverse.push({ type: "del", text: a[i - 1] ?? "" });
      i--;
    } else {
      reverse.push({ type: "ins", text: b[j - 1] ?? "" });
      j--;
    }
  }
  while (i > 0) {
    reverse.push({ type: "del", text: a[i - 1] ?? "" });
    i--;
  }
  while (j > 0) {
    reverse.push({ type: "ins", text: b[j - 1] ?? "" });
    j--;
  }
  for (const seg of reverse.toReversed()) {
    push(seg.type, seg.text);
  }
  return segments;
};
