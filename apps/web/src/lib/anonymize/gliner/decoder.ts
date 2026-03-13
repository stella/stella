/**
 * Decode ONNX model output into entity spans.
 *
 * The span-level model outputs a logits tensor of shape
 * [batch, inputLength, maxWidth, numEntities]. This module
 * applies sigmoid, thresholds, and greedy non-overlapping
 * selection to produce the final entity list.
 */
import type { RawInferenceResult } from "./types";

type Span = [string, number, number, string, number];

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Check if two spans overlap (optionally allowing multi-label). */
const hasOverlapping = (
  a: number[],
  b: number[],
  multiLabel: boolean,
): boolean => {
  if (a[0] === b[0] && a[1] === b[1]) {
    return !multiLabel;
  }
  return !(a[0] > b[1] || b[0] > a[1]);
};

/**
 * Greedy non-overlapping span selection.
 * Sorts by score descending, keeps each span only if it
 * doesn't overlap with already-selected spans.
 */
const greedySearch = (
  spans: Span[],
  flatNer: boolean,
  multiLabel: boolean,
): Span[] => {
  const sorted = spans.toSorted((a, b) => b[4] - a[4]);
  const selected: Span[] = [];

  for (const span of sorted) {
    const overlaps = selected.some((s) => {
      if (flatNer) {
        return hasOverlapping([span[1], span[2]], [s[1], s[2]], multiLabel);
      }
      // Non-flat: also allow nested spans
      const isNested =
        (span[1] <= s[1] && span[2] >= s[2]) ||
        (s[1] <= span[1] && s[2] >= span[2]);
      if (isNested) {
        return false;
      }
      return hasOverlapping([span[1], span[2]], [s[1], s[2]], multiLabel);
    });

    if (!overlaps) {
      selected.push(span);
    }
  }

  return selected.toSorted((a, b) => a[1] - b[1]);
};

/**
 * Decode span-level model logits into entity results.
 */
export const decodeSpans = (
  batchSize: number,
  inputLength: number,
  maxWidth: number,
  numEntities: number,
  texts: string[],
  batchIds: number[],
  batchWordsStartIdx: number[][],
  batchWordsEndIdx: number[][],
  idToClass: Record<number, string>,
  modelOutput: ArrayLike<number>,
  flatNer: boolean,
  threshold: number,
  multiLabel: boolean,
): RawInferenceResult => {
  const spans: Span[][] = Array.from({ length: batchSize }, () => []);

  const batchPadding = inputLength * maxWidth * numEntities;
  const startTokenPadding = maxWidth * numEntities;
  const endTokenPadding = numEntities;

  for (let id = 0; id < modelOutput.length; id++) {
    const batch = Math.floor(id / batchPadding);
    const startToken = Math.floor(id / startTokenPadding) % inputLength;
    const endToken = startToken + (Math.floor(id / endTokenPadding) % maxWidth);
    const entity = id % numEntities;

    const prob = sigmoid(modelOutput[id]);

    if (
      prob >= threshold &&
      startToken < batchWordsStartIdx[batch].length &&
      endToken < batchWordsEndIdx[batch].length
    ) {
      const globalBatch = batchIds[batch];
      const startIdx = batchWordsStartIdx[batch][startToken];
      const endIdx = batchWordsEndIdx[batch][endToken];
      const spanText = texts[globalBatch].slice(startIdx, endIdx);
      spans[batch].push([
        spanText,
        startIdx,
        endIdx,
        idToClass[entity + 1],
        prob,
      ]);
    }
  }

  return spans.map((batchSpans) =>
    greedySearch(batchSpans, flatNer, multiLabel),
  );
};
