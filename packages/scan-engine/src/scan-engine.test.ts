import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import init, { clean_scan_rgba, initSync } from "../generated/scan_engine.js";
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

const onePixelPage = {
  pixels: new Uint8ClampedArray([255, 255, 255, 255]),
  width: 1,
  height: 1,
  pageSize: { widthPoints: 1, heightPoints: 1 },
  dpi: 300,
  rotation: 0,
} satisfies RasterizedScanPage;

const createCleanedWasmResult = (free: () => void) => ({
  status: "cleaned",
  reason: "",
  pixels: new Uint8Array([255]),
  width: 1,
  height: 1,
  skew_degrees: 0,
  content_box: new Uint32Array([0, 0, 1, 1]),
  applied_quad: new Float32Array(),
  free,
});

describe("committed WebAssembly scan engine", () => {
  test("loads the committed bindings through the default loader", async () => {
    const result = await createScanEngine().clean(
      readPgm("blank.pgm"),
      options,
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toEqual({
      type: "unrecognized",
      reason: "no-content",
    });
  });

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

describe("WebAssembly binding recovery", () => {
  test("creates a fresh real instance after a WebAssembly trap", async () => {
    const module = await WebAssembly.compile(wasm);
    const trappedInstance = initSync({ module });

    expect(() =>
      trappedInstance.clean_scan_rgba(
        2_147_483_640,
        1,
        1,
        0,
        0,
        300,
        0,
        0,
        0,
        0,
      ),
    ).toThrow(WebAssembly.RuntimeError);

    const freshInstance = initSync({ module });
    expect(freshInstance.memory).not.toBe(trappedInstance.memory);
    const result = clean_scan_rgba(
      1,
      1,
      new Uint8Array(onePixelPage.pixels.buffer),
      300,
      "binary",
      false,
      false,
    );
    expect(result.status).toBe("unrecognized");
    result.free();
  });

  test("retries after the binding loader rejects", async () => {
    let loadCount = 0;
    const load = async () => {
      loadCount += 1;
      if (loadCount === 1) {
        throw new Error("temporary load failure");
      }
      return {
        default: async () => undefined,
        clean_scan_rgba: () => createCleanedWasmResult(() => undefined),
      };
    };
    const engine = createScanEngine(load);

    expect((await engine.clean(onePixelPage, options)).isErr()).toBe(true);
    expect((await engine.clean(onePixelPage, options)).isOk()).toBe(true);
    expect(loadCount).toBe(2);
  });

  test("reloads bindings after a trapped WebAssembly instance", async () => {
    let loadCount = 0;
    const load = async () => {
      loadCount += 1;
      const currentLoad = loadCount;
      return {
        default: async () => undefined,
        clean_scan_rgba: () => {
          if (currentLoad === 1) {
            throw new WebAssembly.RuntimeError("trapped instance");
          }
          return createCleanedWasmResult(() => undefined);
        },
      };
    };
    const engine = createScanEngine(load);

    expect((await engine.clean(onePixelPage, options)).isErr()).toBe(true);
    expect((await engine.clean(onePixelPage, options)).isOk()).toBe(true);
    expect(loadCount).toBe(2);
  });

  test("frees a WebAssembly result after copying its values", async () => {
    let freeCount = 0;
    const engine = createScanEngine(async () => ({
      default: async () => undefined,
      clean_scan_rgba: () =>
        createCleanedWasmResult(() => {
          freeCount += 1;
        }),
    }));

    expect((await engine.clean(onePixelPage, options)).isOk()).toBe(true);
    expect(freeCount).toBe(1);
  });
});
