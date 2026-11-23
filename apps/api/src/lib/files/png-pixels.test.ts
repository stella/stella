import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { readPngPixels } from "@/api/lib/files/png-pixels";
import { declaredPng, splitPng } from "@/api/tests/helpers/image-fixtures";

const chunk = (type: string, data: Uint8Array) => {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(
    8 + data.length,
    Bun.hash.crc32(out.subarray(4, 8 + data.length)),
  );
  return out;
};

/** Deterministic pseudo-random bytes. */
const noise = (length: number, seed: number) => {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out[index] = state % 256;
  }
  return out;
};

const predictor = (
  filter: number,
  left: number,
  up: number,
  upLeft: number,
) => {
  switch (filter) {
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) {
        return left;
      }
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      return 0;
  }
};

/** A PNG of `samples`, row `y` written with filter `y % 5`. */
const filteredPng = (
  width: number,
  height: number,
  channels: 3 | 4,
  samples: Uint8Array,
) => {
  const stride = width * channels;
  const rows = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    rows[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const at = (dx: number, dy: number) =>
        x + dx < 0 || y + dy < 0
          ? 0
          : (samples[(y + dy) * stride + x + dx] ?? 0);
      const value = at(0, 0);
      const predicted = predictor(
        filter,
        at(-channels, 0),
        at(0, -1),
        at(-channels, -1),
      );
      rows[y * (stride + 1) + 1 + x] = (value - predicted + 256) % 256;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const compressed = deflateSync(rows);
  // Split the stream over two IDAT chunks, as encoders may.
  const half = Math.floor(compressed.length / 2);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed.subarray(0, half)),
    chunk("IDAT", compressed.subarray(half)),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
};

describe("reading the pixels of an 8-bit PNG", () => {
  test.each([3, 4] as const)(
    "every filter type unfilters to the stored samples (%i channels)",
    (channels) => {
      const width = 7;
      const height = 10;
      const samples = noise(width * height * channels, channels);
      const pixels = readPngPixels(
        filteredPng(width, height, channels, samples),
      );
      expect(pixels).not.toBeNull();
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        expect([
          pixels?.rgba[pixel * 4],
          pixels?.rgba[pixel * 4 + 1],
          pixels?.rgba[pixel * 4 + 2],
          pixels?.rgba[pixel * 4 + 3],
        ]).toEqual([
          samples[pixel * channels],
          samples[pixel * channels + 1],
          samples[pixel * channels + 2],
          channels === 4 ? samples[pixel * channels + 3] : 255,
        ]);
      }
    },
  );

  test("the PNG Bun writes reads back as its pixels", async () => {
    Bun.Image.backend = "bun";
    const png = await new Bun.Image(splitPng(8, 2))
      .png({ compressionLevel: 0 })
      .bytes();
    const pixels = readPngPixels(png);
    expect(pixels).toMatchObject({ width: 8, height: 2 });
    expect(Array.from(pixels?.rgba.subarray(0, 4) ?? [])).toEqual([
      255, 0, 0, 255,
    ]);
    expect(Array.from(pixels?.rgba.subarray(28, 32) ?? [])).toEqual([
      0, 0, 255, 255,
    ]);
  });

  test.each([
    ["a palette PNG", () => splitPng(8, 2, "palette")],
    ["a 16-bit PNG", () => declaredPng({ width: 8, height: 8, bitDepth: 16 })],
    [
      "an interlaced PNG",
      () => declaredPng({ width: 8, height: 8, interlaced: true }),
    ],
    [
      "an RGB PNG without image data",
      () => declaredPng({ width: 8, height: 8 }),
    ],
    ["bytes that are not a PNG", () => new TextEncoder().encode("not a png")],
  ])("%s is left to the embedder", (_name, build) => {
    expect(readPngPixels(build())).toBeNull();
  });
});
