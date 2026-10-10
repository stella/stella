import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import init, { clean_scan_rgba } from "../generated/scan_engine.js";
import { createScanEngine } from "./scan-engine";
import type { RasterizedScanPage, ScanOptions } from "./types";

const wasm = readFileSync(
  new URL("../generated/scan_engine_bg.wasm", import.meta.url),
);

const loadRealWasm = async () => {
  await init({ module_or_path: wasm });
  return { default: async () => undefined, clean_scan_rgba };
};

const readPgm = (name: string): RasterizedScanPage => {
  const bytes = readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
  const secondNewline = bytes.indexOf(10, bytes.indexOf(10) + 1);
  const thirdNewline = bytes.indexOf(10, secondNewline + 1);
  const dimensions = new TextDecoder()
    .decode(bytes.subarray(3, secondNewline))
    .split(" ")
    .map(Number);
  const width = dimensions.at(0);
  const height = dimensions.at(1);
  if (width === undefined || height === undefined || thirdNewline === -1) {
    throw new Error(`Invalid PGM fixture: ${name}`);
  }
  const grayscale = bytes.subarray(thirdNewline + 1);
  if (grayscale.length !== width * height) {
    throw new Error(
      `Truncated PGM fixture: ${name} has ${grayscale.length} of ${width * height} pixels`,
    );
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const [index, value] of grayscale.entries()) {
    const output = index * 4;
    pixels[output] = value;
    pixels[output + 1] = value;
    pixels[output + 2] = value;
    pixels[output + 3] = 255;
  }
  return {
    pixels,
    width,
    height,
    pageSize: { widthPoints: width, heightPoints: height },
    dpi: 300,
    rotation: 0,
  };
};

const options = {
  output: "binary",
  contentCrop: "off",
  deskew: "on",
} satisfies ScanOptions;

describe("committed WebAssembly scan engine", () => {
  test("keeps a blank page unrecognized", async () => {
    const result = await createScanEngine(loadRealWasm).clean(
      readPgm("blank.pgm"),
      options,
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toEqual({
      type: "unrecognized",
      reason: "no-content",
    });
  });

  test("deskews a known rotation and emits strictly binary pixels", async () => {
    const result = await createScanEngine(loadRealWasm).clean(
      readPgm("rotated-3-degrees.pgm"),
      options,
    );

    expect(result.isOk()).toBe(true);
    const cleaned = result.unwrap();
    expect(cleaned.type).toBe("cleaned");
    if (cleaned.type !== "cleaned") {
      throw new Error("Expected the rotated fixture to be cleaned");
    }
    expect(Math.abs(cleaned.skewDegrees - 3)).toBeLessThanOrEqual(0.5);
    expect(cleaned.appliedQuad).toBeNull();
    expect(
      cleaned.image.pixels.every((pixel) => pixel === 0 || pixel === 255),
    ).toBe(true);
  });
});
