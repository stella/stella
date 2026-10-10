import { Result } from "better-result";

import { clean_scan_rgba, initSync } from "../generated/scan_engine.js";
import type {
  ContentBox,
  RasterizedScanPage,
  ScanEngine,
  ScanOptions,
  ScanResult,
} from "./types";
import { ScanEngineError } from "./types";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

type WasmScanResult = {
  free: () => void;
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
  clean_scan_rgba: (
    ...args: [
      width: number,
      height: number,
      pixels: Uint8Array,
      dpi: number,
      output: string,
      contentCrop: boolean,
      deskew: boolean,
    ]
  ) => WasmScanResult;
};

type WasmLoader = () => Promise<WasmBindings>;

type AppliedQuad = NonNullable<
  Extract<ScanResult, { type: "cleaned" }>["appliedQuad"]
>;

const WASM_LOAD_TIMEOUT_MS = 10_000;

const loadWasmBindings = async () => {
  const response = await fetch(
    new URL("../generated/scan_engine_bg.wasm", import.meta.url),
    { signal: AbortSignal.timeout(WASM_LOAD_TIMEOUT_MS) },
  );
  const module = await WebAssembly.compile(await response.arrayBuffer());
  initSync({ module });
  return { clean_scan_rgba };
};

const createWorkerEngine = (): ScanEngine => {
  let worker: Worker | undefined;
  let queue = Promise.resolve();

  const reset = () => {
    worker?.terminate();
    worker = undefined;
  };

  const clean = async (page: RasterizedScanPage, options: ScanOptions) => {
    const run = async () => {
      worker ??= new Worker(new URL("scan-engine.worker.ts", import.meta.url), {
        type: "module",
      });
      const activeWorker = worker;
      const pixels = page.pixels.slice().buffer;
      const request: WorkerRequest = {
        page: {
          width: page.width,
          height: page.height,
          pageSize: page.pageSize,
          dpi: page.dpi,
          rotation: page.rotation,
        },
        pixels,
        options,
      };
      return await new Promise<ScanResult>((resolve, reject) => {
        activeWorker.addEventListener(
          "message",
          ({ data }: MessageEvent<WorkerResponse>) => {
            if (data.type === "result") {
              resolve(
                convertResult(
                  { ...data.result, free: () => undefined },
                  options.output,
                ),
              );
              return;
            }
            reset();
            reject(
              data.errorType === "runtime-trap"
                ? new WebAssembly.RuntimeError(data.message)
                : new ScanEngineError({ message: data.message }),
            );
          },
          { once: true },
        );
        activeWorker.addEventListener(
          "error",
          (event) => {
            reset();
            reject(new ScanEngineError({ message: event.message }));
          },
          { once: true },
        );
        activeWorker.postMessage(request, [pixels]);
      });
    };
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return await Result.tryPromise({
      try: async () => await result,
      catch: (cause) =>
        cause instanceof ScanEngineError
          ? cause
          : new ScanEngineError({
              message: "The scan engine could not clean the page",
              cause,
            }),
    });
  };
  return { clean };
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

const readQuad = (values: Float32Array): AppliedQuad | null => {
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

export const createScanEngine = (load?: WasmLoader): ScanEngine => {
  if (load === undefined && typeof Worker !== "undefined") {
    return createWorkerEngine();
  }
  // Non-worker runtimes compile once, while the patched initSync glue creates a new
  // WebAssembly.Instance whenever recovery clears the cached binding promise.
  const resolvedLoad = load ?? loadWasmBindings;
  let bindings: Promise<WasmBindings> | undefined;
  return {
    clean: async (page: RasterizedScanPage, options: ScanOptions) =>
      await Result.tryPromise({
        try: async () => {
          if (bindings === undefined) {
            const pending = resolvedLoad().catch((error: unknown) => {
              if (bindings === pending) {
                bindings = undefined;
              }
              throw error;
            });
            bindings = pending;
          }
          const wasm = await bindings;
          try {
            let result: WasmScanResult | undefined;
            try {
              result = wasm.clean_scan_rgba(
                page.width,
                page.height,
                new Uint8Array(
                  page.pixels.buffer,
                  page.pixels.byteOffset,
                  page.pixels.byteLength,
                ),
                page.dpi,
                options.output,
                options.contentCrop === "on",
                options.deskew === "on",
              );
              return convertResult(result, options.output);
            } finally {
              result?.free();
            }
          } catch (error) {
            if (error instanceof WebAssembly.RuntimeError) {
              bindings = undefined;
            }
            throw error;
          }
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
