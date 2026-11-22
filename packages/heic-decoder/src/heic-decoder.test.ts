import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createHeicDecoder, type HeicPreview } from "./heic-decoder";

const fixtureUrl = (name: string) =>
  new URL(`../fixtures/${name}`, import.meta.url);

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fixtureUrl(name)));

/**
 * Per-block RGB means of the platform decoder's sRGB rendering of a fixture
 * (see `fixtures/README.md`), in the order `blockMeans` returns them.
 */
type Reference = {
  width: number;
  height: number;
  blocks: number;
  means: number[];
};

const reference = (name: string): Reference =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a committed fixture of a fixed shape
  JSON.parse(readFileSync(fixtureUrl(name), "utf-8")) as Reference;

const decoder = createHeicDecoder();

const GENEROUS = { maxDecodedPixels: 50_000_000, maxOutputPixels: 50_000_000 };

const decoded = (result: HeicPreview) => {
  if (result.type !== "decoded") {
    throw new Error(`expected pixels, got ${result.type}`);
  }
  return result;
};

/** Mean of each RGB channel over a grid of `blocks` x `blocks` blocks. */
const blockMeans = (
  { rgba, width, height }: { rgba: Uint8Array; width: number; height: number },
  blocks: number,
) => {
  const means: number[] = [];
  for (let by = 0; by < blocks; by += 1) {
    for (let bx = 0; bx < blocks; bx += 1) {
      const sums = [0, 0, 0];
      let count = 0;
      const x0 = Math.floor((bx * width) / blocks);
      const x1 = Math.floor(((bx + 1) * width) / blocks);
      const y0 = Math.floor((by * height) / blocks);
      const y1 = Math.floor(((by + 1) * height) / blocks);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          for (let channel = 0; channel < 3; channel += 1) {
            sums[channel] =
              (sums[channel] ?? 0) + (rgba[(y * width + x) * 4 + channel] ?? 0);
          }
          count += 1;
        }
      }
      means.push(...sums.map((sum) => sum / count));
    }
  }
  return means;
};

const expectCloseTo = (
  result: Extract<HeicPreview, { type: "decoded" }>,
  expected: Reference,
  tolerance: number,
) => {
  expect([result.width, result.height]).toEqual([
    expected.width,
    expected.height,
  ]);
  for (const [index, value] of blockMeans(result, expected.blocks).entries()) {
    expect(Math.abs(value - (expected.means[index] ?? 0))).toBeLessThan(
      tolerance,
    );
  }
};

/** Offset of the first `irot` property box's payload. */
const irotPayload = (bytes: Uint8Array) => {
  const name = new TextEncoder().encode("irot");
  for (let offset = 4; offset + 4 <= bytes.length; offset += 1) {
    if (name.every((byte, index) => bytes[offset + index] === byte)) {
      return offset + 4;
    }
  }
  throw new Error("no irot box");
};

describe("createHeicDecoder", () => {
  test("decodes a tiled photo as the platform decoder shows it", () => {
    const result = decoded(decoder.decode(fixture("grid.heic"), GENEROUS));
    expect(result.rgba.length).toBe(1100 * 700 * 4);
    expectCloseTo(result, reference("grid-reference.json"), 2);
  });

  test("converts a Display P3 photo to sRGB", () => {
    const result = decoded(decoder.decode(fixture("p3.heic"), GENEROUS));
    expectCloseTo(result, reference("p3-reference.json"), 3);
  });

  test("scales a photo down to the output budget, keeping its shape", () => {
    const result = decoded(
      decoder.decode(fixture("grid.heic"), {
        maxDecodedPixels: 1100 * 700,
        maxOutputPixels: 110 * 70,
      }),
    );
    expect([result.width, result.height]).toEqual([110, 70]);
    expect(result.rgba.length).toBe(110 * 70 * 4);
  });

  test("keeps transparency", () => {
    const result = decoded(decoder.decode(fixture("alpha.heic"), GENEROUS));
    const alphaAt = (x: number, y: number) =>
      result.rgba[(y * result.width + x) * 4 + 3] ?? -1;
    expect(alphaAt(0, 0)).toBeLessThan(16);
    expect(alphaAt(150, 100)).toBeGreaterThan(240);
  });

  test("applies the file's rotation", () => {
    const bytes = fixture("grid.heic");
    // irot holds one byte: the angle in quarter turns anticlockwise.
    bytes[irotPayload(bytes)] = 1;
    const result = decoded(decoder.decode(bytes, GENEROUS));
    expect([result.width, result.height]).toEqual([700, 1100]);
  });

  test("refuses a photo over the decoded budget", () => {
    const limits = { maxDecodedPixels: 1100 * 700, maxOutputPixels: 1 };
    expect(decoder.decode(fixture("grid.heic"), limits).type).toBe("decoded");
    expect(
      decoder.decode(fixture("grid.heic"), {
        ...limits,
        maxDecodedPixels: 1100 * 700 - 1,
      }),
    ).toEqual({ type: "too-large" });
  });

  test("refuses bytes that are not HEIF", () => {
    for (const bytes of [
      new Uint8Array(0),
      new TextEncoder().encode("not a photo"),
      fixture("grid.heic").subarray(0, 200),
    ]) {
      expect(decoder.decode(bytes, GENEROUS)).toEqual({ type: "unreadable" });
    }
  });

  test("rejects limits that are not positive integers", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        decoder.decode(fixture("single.heic"), {
          maxDecodedPixels: limit,
          maxOutputPixels: 1,
        }),
      ).toThrow("pixel limits must be positive integers");
    }
  });
});
