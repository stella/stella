import { describe, expect, test } from "bun:test";

import {
  buildCtcDecodeTable,
  compareReadingOrder,
  decodeCtc,
  detInputSize,
  extractTextBoxes,
  packRecCrop,
  REC_INPUT_HEIGHT,
} from "@/api/lib/ocr-local/ppocr-pipeline";

const probMap = (
  width: number,
  height: number,
  regions: { x0: number; y0: number; x1: number; y1: number; value: number }[],
): Float32Array => {
  const map = new Float32Array(width * height);
  for (const region of regions) {
    for (let y = region.y0; y < region.y1; y += 1) {
      for (let x = region.x0; x < region.x1; x += 1) {
        map[y * width + x] = region.value;
      }
    }
  }
  return map;
};

describe("detInputSize", () => {
  test("caps the longest side and rounds to multiples of 32", () => {
    const size = detInputSize({ width: 2550, height: 3300 });
    expect(size.height).toBe(960);
    expect(size.width % 32).toBe(0);
    expect(size.width).toBeLessThanOrEqual(768);
  });

  test("keeps small inputs at native resolution rounded to /32", () => {
    const size = detInputSize({ width: 300, height: 200 });
    expect(size).toEqual({ width: 288, height: 192 });
  });
});

describe("extractTextBoxes", () => {
  test("finds separated components and maps them to source coordinates", () => {
    const prob = probMap(64, 64, [
      { x0: 4, y0: 4, x1: 30, y1: 10, value: 0.9 },
      { x0: 4, y0: 40, x1: 40, y1: 48, value: 0.9 },
    ]);
    const boxes = extractTextBoxes({
      prob,
      probWidth: 64,
      probHeight: 64,
      sourceWidth: 640,
      sourceHeight: 640,
    });

    expect(boxes.length).toBe(2);
    // Reading order: the upper region first.
    expect(boxes[0]!.y0).toBeLessThan(boxes[1]!.y0);
    // Coordinates are scaled 10x and expanded by the unclip offset.
    expect(boxes[0]!.x0).toBeLessThan(40);
    expect(boxes[0]!.x1).toBeGreaterThan(290);
    expect(boxes[0]!.score).toBeCloseTo(0.9, 5);
  });

  test("drops components below the score threshold or minimum size", () => {
    const prob = probMap(64, 64, [
      { x0: 4, y0: 4, x1: 30, y1: 10, value: 0.4 },
      { x0: 40, y0: 40, x1: 42, y1: 42, value: 0.95 },
    ]);
    const boxes = extractTextBoxes({
      prob,
      probWidth: 64,
      probHeight: 64,
      sourceWidth: 64,
      sourceHeight: 64,
    });

    expect(boxes).toEqual([]);
  });
});

describe("compareReadingOrder", () => {
  test("orders left-to-right within a line band, top-to-bottom across bands", () => {
    const left = { x0: 0, y0: 100, x1: 50, y1: 120, score: 1 };
    const right = { x0: 60, y0: 103, x1: 110, y1: 123, score: 1 };
    const below = { x0: 0, y0: 200, x1: 50, y1: 220, score: 1 };

    expect([below, right, left].sort(compareReadingOrder)).toEqual([
      left,
      right,
      below,
    ]);
  });
});

describe("decodeCtc", () => {
  const table = buildCtcDecodeTable("a\nb");

  const logits = (rows: number[][]): Float32Array => {
    const classes = rows[0]?.length ?? 0;
    const data = new Float32Array(rows.length * classes);
    for (const [ri, row] of rows.entries()) {
      for (const [ci, value] of row.entries()) {
        data[ri * classes + ci] = value;
      }
    }
    return data;
  };

  test("collapses repeats and drops blanks", () => {
    // Steps: a a blank a b -> "aab"
    const data = logits([
      [0.1, 0.8, 0.1, 0],
      [0.1, 0.8, 0.1, 0],
      [0.9, 0.05, 0.05, 0],
      [0.1, 0.8, 0.1, 0],
      [0.1, 0.1, 0.8, 0],
    ]);
    const decoded = decodeCtc({
      classes: 4,
      data,
      offset: 0,
      steps: 5,
      table,
    });

    expect(decoded.text).toBe("aab");
    expect(decoded.confidence).toBeCloseTo(0.8, 5);
  });

  test("decodes the appended space class", () => {
    const data = logits([
      [0.1, 0.8, 0.1, 0],
      [0, 0, 0, 1],
      [0.1, 0.1, 0.8, 0],
    ]);
    const decoded = decodeCtc({
      classes: 4,
      data,
      offset: 0,
      steps: 3,
      table,
    });

    expect(decoded.text).toBe("a b");
  });
});

describe("packRecCrop", () => {
  test("normalizes to [-1, 1] and writes only the crop region", () => {
    const cropWidth = 2;
    const batchWidth = 4;
    const crop = new Uint8Array(cropWidth * REC_INPUT_HEIGHT * 3).fill(255);
    const tensor = new Float32Array(3 * REC_INPUT_HEIGHT * batchWidth).fill(9);

    packRecCrop({ batchIndex: 0, batchWidth, crop, cropWidth, tensor });

    expect(tensor[0]).toBeCloseTo(1, 5);
    // Padding columns keep the allocation's fill (zero in production).
    expect(tensor[cropWidth]).toBe(9);
  });
});
