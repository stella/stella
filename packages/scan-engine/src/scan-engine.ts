import { Result } from "better-result";

import type {
  ContentBox,
  Quad,
  RasterizedScanPage,
  ScanEngine,
  ScanOptions,
  ScanResult,
} from "./types";
import { ScanEngineError } from "./types";

type WasmScanResult = {
  readonly status: string;
  readonly reason: string;
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly skew_degrees: number;
  readonly content_box: Uint32Array;
  readonly applied_quad: Float32Array;
};

type WasmBindings = {
  default: () => Promise<unknown>;
  clean_scan_rgba: (
    ...args: [
      width: number,
      height: number,
      pixels: Uint8ClampedArray,
      dpi: number,
      output: ScanOptions["output"],
      contentCrop: boolean,
      deskew: boolean,
    ]
  ) => WasmScanResult;
};

type WasmLoader = () => Promise<WasmBindings>;

const WASM_GLUE_PATH = "../pkg/scan_engine.js";

const isWasmBindings = (value: unknown): value is WasmBindings =>
  typeof value === "object" &&
  value !== null &&
  "default" in value &&
  typeof value.default === "function" &&
  "clean_scan_rgba" in value &&
  typeof value.clean_scan_rgba === "function";

const loadWasmBindings = async () => {
  const imported: unknown = await import(WASM_GLUE_PATH);
  if (!isWasmBindings(imported)) {
    throw new ScanEngineError({
      message: "The scan engine WebAssembly module has an invalid interface",
    });
  }
  await imported.default();
  return imported;
};

const readContentBox = (values: Uint32Array): ContentBox => {
  const x = values.at(0);
  const y = values.at(1);
  const width = values.at(2);
  const height = values.at(3);
  if (
    values.length !== 4 ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    throw new ScanEngineError({
      message: "The scan engine returned an invalid content box",
    });
  }
  return { x, y, width, height };
};

const readQuad = (values: Float32Array): Quad | null => {
  if (values.length === 0) {
    return null;
  }
  const coordinates = Array.from(values);
  if (
    coordinates.length !== 8 ||
    coordinates.some((value) => !Number.isFinite(value))
  ) {
    throw new ScanEngineError({
      message: "The scan engine returned an invalid page quadrilateral",
    });
  }
  const [x0, y0, x1, y1, x2, y2, x3, y3] = coordinates;
  if (
    x0 === undefined ||
    y0 === undefined ||
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    x3 === undefined ||
    y3 === undefined
  ) {
    throw new ScanEngineError({
      message: "The scan engine returned an invalid page quadrilateral",
    });
  }
  return {
    topLeft: { x: x0, y: y0 },
    topRight: { x: x1, y: y1 },
    bottomRight: { x: x2, y: y2 },
    bottomLeft: { x: x3, y: y3 },
  };
};

const convertResult = (
  result: WasmScanResult,
  output: ScanOptions["output"],
): ScanResult => {
  if (result.status === "unrecognized") {
    if (result.reason.length === 0) {
      throw new ScanEngineError({
        message:
          "The scan engine returned an unrecognized page without a reason",
      });
    }
    return { type: "unrecognized", reason: result.reason };
  }
  if (result.status !== "cleaned") {
    throw new ScanEngineError({
      message: `The scan engine returned an unknown status: ${result.status}`,
    });
  }
  if (result.pixels.length !== result.width * result.height) {
    throw new ScanEngineError({
      message: "The scan engine returned an invalid pixel buffer",
    });
  }
  return {
    type: "cleaned",
    image: {
      pixels: result.pixels,
      width: result.width,
      height: result.height,
      format: output,
    },
    appliedQuad: readQuad(result.applied_quad),
    skewDegrees: result.skew_degrees,
    contentBox: readContentBox(result.content_box),
  };
};

export const createScanEngine = (
  load: WasmLoader = loadWasmBindings,
): ScanEngine => {
  let bindings: Promise<WasmBindings> | undefined;
  return {
    clean: async (page: RasterizedScanPage, options: ScanOptions) =>
      await Result.tryPromise({
        try: async () => {
          bindings ??= load();
          const wasm = await bindings;
          const result = wasm.clean_scan_rgba(
            page.width,
            page.height,
            page.pixels,
            page.dpi,
            options.output,
            options.contentCrop === "on",
            options.deskew === "on",
          );
          return convertResult(result, options.output);
        },
        catch: (cause) =>
          cause instanceof ScanEngineError
            ? cause
            : new ScanEngineError({
                message: "The scan engine could not clean the page",
                cause,
              }),
      }),
  };
};

export const scanEngine = createScanEngine();
