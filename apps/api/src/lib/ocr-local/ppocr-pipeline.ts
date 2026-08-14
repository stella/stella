/**
 * Pure tensor-space stages of the PP-OCR pipeline: detection input sizing
 * and normalization, DB probability-map postprocessing, recognition batch
 * packing, and CTC decoding. Kept free of I/O and inference so every stage
 * is unit-testable; `ocr-local-worker.ts` wires them to onnxruntime.
 *
 * Parameters follow the PaddleOCR/RapidOCR reference implementation:
 * detection runs on a copy downscaled to `DET_LIMIT_SIDE` (dimensions
 * rounded to multiples of 32), boxes are mapped back to the source image,
 * and recognition crops are cut from the source at full resolution.
 */

export const DET_LIMIT_SIDE = 960;
export const REC_INPUT_HEIGHT = 48;
export const REC_BATCH_SIZE = 6;
export const REC_MAX_INPUT_WIDTH = 4000;

const DET_PROB_THRESH = 0.3;
const DET_BOX_SCORE_THRESH = 0.5;
const DET_UNCLIP_RATIO = 1.6;
const MIN_COMPONENT_PIXELS = 20;
const MIN_BOX_SIDE = 3;
const DET_MEAN: readonly number[] = [0.485, 0.456, 0.406];
const DET_STD: readonly number[] = [0.229, 0.224, 0.225];

export type TextBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
};

/** Detection input dimensions: capped longest side, rounded to /32. */
export const detInputSize = ({
  height,
  width,
}: {
  height: number;
  width: number;
}): { height: number; width: number } => {
  const longest = Math.max(width, height);
  const ratio = longest > DET_LIMIT_SIDE ? DET_LIMIT_SIDE / longest : 1;
  return {
    width: Math.max(32, Math.round((width * ratio) / 32) * 32),
    height: Math.max(32, Math.round((height * ratio) / 32) * 32),
  };
};

/** RGB bytes to a normalized NCHW float tensor for the detection model. */
export const normalizeDetInput = (
  rgb: Uint8Array,
  pixelCount: number,
): Float32Array => {
  const input = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const value = (rgb[i * 3 + c] ?? 0) / 255;
      input[c * pixelCount + i] =
        (value - (DET_MEAN[c] ?? 0)) / (DET_STD[c] ?? 1);
    }
  }
  return input;
};

type ExtractTextBoxesOptions = {
  prob: Float32Array;
  probWidth: number;
  probHeight: number;
  sourceWidth: number;
  sourceHeight: number;
};

/**
 * DB postprocess: binarize the probability map, take connected components,
 * expand each axis-aligned box with the Vatti-offset approximation, and map
 * coordinates back to the source image. Returned boxes are sorted in
 * reading order (top-to-bottom, left-to-right within a line band).
 */
export const extractTextBoxes = ({
  prob,
  probHeight,
  probWidth,
  sourceHeight,
  sourceWidth,
}: ExtractTextBoxesOptions): TextBox[] => {
  const plane = probWidth * probHeight;
  const visited = new Uint8Array(plane);
  const stack = new Int32Array(plane);
  const scaleX = sourceWidth / probWidth;
  const scaleY = sourceHeight / probHeight;
  const boxes: TextBox[] = [];

  for (let start = 0; start < plane; start += 1) {
    if ((prob[start] ?? 0) <= DET_PROB_THRESH || visited[start] === 1) {
      continue;
    }
    let top = 0;
    stack[top] = start;
    top += 1;
    visited[start] = 1;
    let minX = probWidth;
    let maxX = 0;
    let minY = probHeight;
    let maxY = 0;
    let sum = 0;
    let count = 0;
    while (top > 0) {
      top -= 1;
      const p = stack[top] ?? 0;
      const py = Math.floor(p / probWidth);
      const px = p - py * probWidth;
      sum += prob[p] ?? 0;
      count += 1;
      if (px < minX) {
        minX = px;
      }
      if (px > maxX) {
        maxX = px;
      }
      if (py < minY) {
        minY = py;
      }
      if (py > maxY) {
        maxY = py;
      }
      const left = px > 0 ? p - 1 : -1;
      const right = px < probWidth - 1 ? p + 1 : -1;
      const up = p - probWidth;
      const down = p + probWidth;
      for (const n of [left, right, up, down]) {
        if (n < 0 || n >= plane || visited[n] === 1) {
          continue;
        }
        if ((prob[n] ?? 0) <= DET_PROB_THRESH) {
          continue;
        }
        visited[n] = 1;
        stack[top] = n;
        top += 1;
      }
    }
    if (count < MIN_COMPONENT_PIXELS) {
      continue;
    }
    const score = sum / count;
    if (score < DET_BOX_SCORE_THRESH) {
      continue;
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const offset = (width * height * DET_UNCLIP_RATIO) / (2 * (width + height));
    boxes.push({
      x0: Math.max(0, Math.floor((minX - offset) * scaleX)),
      y0: Math.max(0, Math.floor((minY - offset) * scaleY)),
      x1: Math.min(sourceWidth, Math.ceil((maxX + offset) * scaleX)),
      y1: Math.min(sourceHeight, Math.ceil((maxY + offset) * scaleY)),
      score,
    });
  }

  return boxes
    .filter((b) => b.x1 - b.x0 >= MIN_BOX_SIDE && b.y1 - b.y0 >= MIN_BOX_SIDE)
    .sort(compareReadingOrder);
};

/** Top-to-bottom; left-to-right for boxes on the same text line band. */
export const compareReadingOrder = (a: TextBox, b: TextBox): number => {
  const tolerance = Math.min(a.y1 - a.y0, b.y1 - b.y0) / 2;
  if (Math.abs(a.y0 - b.y0) > tolerance) {
    return a.y0 - b.y0;
  }
  return a.x0 - b.x0;
};

type PackRecCropOptions = {
  crop: Uint8Array;
  cropWidth: number;
  batchIndex: number;
  batchWidth: number;
  tensor: Float32Array;
};

/**
 * Write one recognition crop (RGB, height `REC_INPUT_HEIGHT`) into its slot
 * of the batch tensor, normalized to [-1, 1] and right-padded with zeros.
 */
export const packRecCrop = ({
  batchIndex,
  batchWidth,
  crop,
  cropWidth,
  tensor,
}: PackRecCropOptions): void => {
  const base = batchIndex * 3 * REC_INPUT_HEIGHT * batchWidth;
  for (let y = 0; y < REC_INPUT_HEIGHT; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        tensor[base + c * REC_INPUT_HEIGHT * batchWidth + y * batchWidth + x] =
          (crop[(y * cropWidth + x) * 3 + c] ?? 0) / 127.5 - 1;
      }
    }
  }
};

/** CTC decode table: blank at index 0, then the dictionary, then space. */
export const buildCtcDecodeTable = (dictionary: string): string[] => [
  "",
  ...dictionary.split("\n").map((line) => line.replace(/\r$/u, "")),
  " ",
];

type DecodeCtcOptions = {
  data: Float32Array;
  /** Offset of this sequence's first logit row in `data`. */
  offset: number;
  steps: number;
  classes: number;
  table: string[];
};

/**
 * Greedy CTC decode of one sequence: argmax per step, collapse repeats,
 * drop blanks. Confidence is the mean probability of emitted characters.
 */
export const decodeCtc = ({
  classes,
  data,
  offset,
  steps,
  table,
}: DecodeCtcOptions): { confidence: number; text: string } => {
  let text = "";
  let previous = -1;
  let probSum = 0;
  let emitted = 0;
  for (let step = 0; step < steps; step += 1) {
    const row = offset + step * classes;
    let best = 0;
    let bestValue = data[row] ?? 0;
    for (let ci = 1; ci < classes; ci += 1) {
      const value = data[row + ci] ?? 0;
      if (value > bestValue) {
        bestValue = value;
        best = ci;
      }
    }
    if (best !== 0 && best !== previous) {
      text += table[best] ?? "";
      probSum += bestValue;
      emitted += 1;
    }
    previous = best;
  }
  return { confidence: emitted > 0 ? probSum / emitted : 0, text };
};
