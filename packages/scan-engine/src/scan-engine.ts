import { Result, panic } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import {
  clean_scan_rgba,
  detect_page_quad_rgba,
  initSync,
} from "../generated/scan_engine.js";
import {
  readAppliedScanQuad,
  scanCornerSuggestion,
  writeScanQuad,
} from "./scan-geometry";
import type {
  ContentBox,
  RasterizedScanPage,
  ScanEngine,
  ScanOptions,
  CleanScanResult,
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
      corners: Float32Array,
    ]
  ) => WasmScanResult;
  detect_page_quad_rgba: (
    width: number,
    height: number,
    pixels: Uint8Array,
  ) => Float32Array;
};

type WasmLoader = () => Promise<WasmBindings>;

const WASM_LOAD_TIMEOUT_MS = 10_000;
const WORKER_REQUEST_TIMEOUT_MS = 10_000;

type WorkerClient = {
  addEventListener: (
    type: "message" | "error",
    listener: (event: MessageEvent<WorkerResponse> | ErrorEvent) => void,
  ) => void;
  removeEventListener: (
    type: "message" | "error",
    listener: (event: MessageEvent<WorkerResponse> | ErrorEvent) => void,
  ) => void;
  postMessage: (message: WorkerRequest, transfer: ArrayBuffer[]) => void;
  terminate: () => void;
};

type WorkerEngineOptions = {
  createWorker?: () => WorkerClient;
  requestTimeoutMs?: number;
};

const loadWasmBindings = async () => {
  const response = await fetchWithTimeout(
    new URL("../generated/scan_engine_bg.wasm", import.meta.url),
    { timeout: { type: "idle", ms: WASM_LOAD_TIMEOUT_MS } },
  );
  const module = await WebAssembly.compile(await response.arrayBuffer());
  initSync({ module });
  return { clean_scan_rgba, detect_page_quad_rgba };
};

const createWorkerEngine = ({
  createWorker = () =>
    new Worker(new URL("scan-engine.worker.ts", import.meta.url), {
      type: "module",
    }),
  requestTimeoutMs = WORKER_REQUEST_TIMEOUT_MS,
}: WorkerEngineOptions = {}): ScanEngine => {
  let worker: WorkerClient | undefined;
  let queue = Promise.resolve();

  const reset = () => {
    worker?.terminate();
    worker = undefined;
  };

  const send = async (request: WorkerRequest) => {
    const run = async () => {
      worker ??= createWorker();
      const activeWorker = worker;
      return await new Promise<WorkerResponse>((resolve, reject) => {
        let settled = false;
        const settle = (complete: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          activeWorker.removeEventListener("message", onMessage);
          activeWorker.removeEventListener("error", onError);
          complete();
        };
        const onMessage = (
          event: MessageEvent<WorkerResponse> | ErrorEvent,
        ) => {
          if (!(event instanceof MessageEvent)) {
            return;
          }
          const { data } = event;
          switch (data.type) {
            case "result":
            case "detected":
              settle(() => resolve(data));
              return;
            case "error":
              reset();
              settle(() =>
                reject(
                  data.errorType === "runtime-trap"
                    ? new WebAssembly.RuntimeError(data.message)
                    : new ScanEngineError({
                        type: "engine-failure",
                        message: data.message,
                      }),
                ),
              );
              return;
            default: {
              const failure = Result.try(() =>
                panic(
                  `Unexpected worker response: ${String(data satisfies never)}`,
                ),
              );
              if (failure.isErr()) {
                settle(() => reject(failure.error));
              }
              return;
            }
          }
        };
        const onError = (event: MessageEvent<WorkerResponse> | ErrorEvent) => {
          if (!(event instanceof ErrorEvent)) {
            return;
          }
          reset();
          settle(() =>
            reject(
              new ScanEngineError({
                type: "engine-failure",
                message: event.message,
              }),
            ),
          );
        };
        const timeout = setTimeout(() => {
          reset();
          settle(() =>
            reject(
              new ScanEngineError({
                type: "engine-timeout",
                message: "The scan engine request timed out",
              }),
            ),
          );
        }, requestTimeoutMs);
        activeWorker.addEventListener("message", onMessage);
        activeWorker.addEventListener("error", onError);
        activeWorker.postMessage(request, [request.pixels]);
      });
    };
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };

  const pageRequest = (page: RasterizedScanPage) => ({
    page: {
      width: page.width,
      height: page.height,
      pageSize: page.pageSize,
      dpi: page.dpi,
      rotation: page.rotation,
    },
    pixels: page.pixels.slice().buffer,
  });

  const detect = async (page: RasterizedScanPage) =>
    await Result.tryPromise({
      try: async () => {
        const response = await send({ type: "detect", ...pageRequest(page) });
        switch (response.type) {
          case "detected":
            return response.suggestion;
          case "result":
            throw new ScanEngineError({
              type: "engine-failure",
              message:
                "The scan engine returned the wrong response for detection",
            });
          case "error":
            throw new ScanEngineError({
              type: "engine-failure",
              message: response.message,
            });
          default:
            return panic(
              `Unexpected worker response: ${String(response satisfies never)}`,
            );
        }
      },
      catch: (cause) =>
        cause instanceof ScanEngineError
          ? cause
          : new ScanEngineError({
              type: "engine-failure",
              message: "The scan engine could not detect page corners",
              cause,
            }),
    });

  const clean = async (page: RasterizedScanPage, options: ScanOptions) =>
    await Result.tryPromise({
      try: async () => {
        const response = await send({
          type: "clean",
          ...pageRequest(page),
          options,
        });
        switch (response.type) {
          case "result":
            return convertResult(
              { ...response.result, free: () => undefined },
              options.output,
            );
          case "detected":
            throw new ScanEngineError({
              type: "engine-failure",
              message:
                "The scan engine returned the wrong response for cleaning",
            });
          case "error":
            throw new ScanEngineError({
              type: "engine-failure",
              message: response.message,
            });
          default:
            return panic(
              `Unexpected worker response: ${String(response satisfies never)}`,
            );
        }
      },
      catch: (cause) =>
        cause instanceof ScanEngineError
          ? cause
          : new ScanEngineError({
              type: "engine-failure",
              message: "The scan engine could not clean the page",
              cause,
            }),
    });
  return { clean, detect };
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
      type: "engine-failure",
      message: "The scan engine returned an invalid content box",
    });
  }
  return { x, y, width, height };
};

const convertResult = (
  result: WasmScanResult,
  output: ScanOptions["output"],
): CleanScanResult => {
  if (result.status === "unrecognized") {
    if (result.reason.length === 0) {
      throw new ScanEngineError({
        type: "engine-failure",
        message:
          "The scan engine returned an unrecognized page without a reason",
      });
    }
    return { type: "unrecognized", reason: result.reason };
  }
  if (result.status !== "cleaned") {
    throw new ScanEngineError({
      type: "engine-failure",
      message: `The scan engine returned an unknown status: ${result.status}`,
    });
  }
  if (result.pixels.length !== result.width * result.height) {
    throw new ScanEngineError({
      type: "engine-failure",
      message: "The scan engine returned an invalid pixel buffer",
    });
  }
  const appliedQuad = readAppliedScanQuad(result.applied_quad);
  if (appliedQuad.isErr()) {
    throw appliedQuad.error;
  }
  return {
    type: "cleaned",
    image: {
      pixels: result.pixels,
      width: result.width,
      height: result.height,
      format: output,
    },
    appliedQuad: appliedQuad.value,
    skewDegrees: result.skew_degrees,
    contentBox: readContentBox(result.content_box),
  };
};

export const createScanEngine = (
  load?: WasmLoader,
  workerOptions?: WorkerEngineOptions,
): ScanEngine => {
  if (load === undefined && typeof Worker !== "undefined") {
    return createWorkerEngine(workerOptions);
  }
  // Non-worker runtimes compile once, while the patched initSync glue creates a new
  // WebAssembly.Instance whenever recovery clears the cached binding promise.
  const resolvedLoad = load ?? loadWasmBindings;
  let bindings: Promise<WasmBindings> | undefined;
  return {
    detect: async (page: RasterizedScanPage) =>
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
          const suggestion = scanCornerSuggestion(
            wasm.detect_page_quad_rgba(
              page.width,
              page.height,
              new Uint8Array(
                page.pixels.buffer,
                page.pixels.byteOffset,
                page.pixels.byteLength,
              ),
            ),
            page,
          );
          if (suggestion.isErr()) {
            throw suggestion.error;
          }
          return suggestion.value;
        },
        catch: (cause) =>
          cause instanceof ScanEngineError
            ? cause
            : new ScanEngineError({
                type: "engine-failure",
                message: "The scan engine could not detect page corners",
                cause,
              }),
      }),
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
                writeScanQuad(options.corners),
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
                type: "engine-failure",
                message: "The scan engine could not clean the page",
                cause,
              }),
      }),
  };
};

export const scanEngine = createScanEngine();
