/**
 * Token-level BIO decoder for GLiNER TokenGLiNER models
 * (e.g., gliner-pii-edge-v1.0).
 *
 * These models output logits of shape [B, L, C, 3] where:
 *   B = batch size
 *   L = number of words (text_lengths)
 *   C = number of entity classes
 *   3 = BIO tags: [B(egin), I(nside), O(utside)]
 *
 * This decoder converts BIO-tagged logits into entity spans
 * with character offsets.
 */
import type { RawInferenceResult } from "./types";

type Span = [string, number, number, string, number];

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const B_TAG = 0;
const I_TAG = 1;

/**
 * Decode token-level BIO logits into entity spans.
 *
 * For each word, checks if the B(egin) logit for any class
 * exceeds the threshold. If so, extends the span by consuming
 * subsequent I(nside) tokens of the same class.
 */
export const decodeTokenSpans = (
  batchSize: number,
  numWords: number,
  numEntities: number,
  texts: string[],
  batchIds: number[],
  batchWordsStartIdx: number[][],
  batchWordsEndIdx: number[][],
  idToClass: Record<number, string>,
  modelOutput: ArrayLike<number>,
  threshold: number,
): RawInferenceResult => {
  const results: Span[][] = Array.from({ length: batchSize }, () => []);

  const wordStride = numEntities * 3;
  const batchStride = numWords * wordStride;

  for (let b = 0; b < batchSize; b++) {
    const batchOffset = b * batchStride;
    const starts = batchWordsStartIdx[b];
    const ends = batchWordsEndIdx[b];
    const globalBatch = batchIds[b] ?? 0;
    const text = texts[globalBatch] ?? "";
    const batchSpans = results[b];

    if (!starts || !ends || !batchSpans) {
      continue;
    }

    const actualWords = starts.length;

    for (let e = 0; e < numEntities; e++) {
      let w = 0;

      while (w < actualWords) {
        const bLogitIdx = batchOffset + w * wordStride + e * 3 + B_TAG;
        const bScore = sigmoid(modelOutput[bLogitIdx] ?? 0);

        if (bScore < threshold) {
          w++;
          continue;
        }

        const spanStart = w;
        let spanEnd = w;
        let maxScore = bScore;

        while (spanEnd + 1 < actualWords) {
          const iLogitIdx =
            batchOffset + (spanEnd + 1) * wordStride + e * 3 + I_TAG;
          const iScore = sigmoid(modelOutput[iLogitIdx] ?? 0);

          if (iScore < threshold) {
            break;
          }

          spanEnd++;
          maxScore = Math.max(maxScore, iScore);
        }

        const charStart = starts[spanStart] ?? 0;
        const charEnd = ends[spanEnd] ?? 0;
        const spanText = text.slice(charStart, charEnd);
        const label = idToClass[e + 1] ?? "";

        if (spanText.trim().length > 0 && label) {
          batchSpans.push([spanText, charStart, charEnd, label, maxScore]);
        }

        w = spanEnd + 1;
      }
    }

    const selected: Span[] = [];
    for (const span of batchSpans.toSorted((x, y) => y[4] - x[4])) {
      const overlaps = selected.some((s) => span[1] < s[2] && span[2] > s[1]);
      if (!overlaps) {
        selected.push(span);
      }
    }

    results[b] = selected.toSorted((x, y) => x[1] - y[1]);
  }

  return results;
};
