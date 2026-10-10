import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import init, { clean_scan_rgba } from "../generated/scan_engine.js";
import { createScanEngine } from "./scan-engine";
import type { RasterizedScanPage, ScanOptions } from "./types";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

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

const createCleanedWasmResult = (
  free: () => void,
  appliedQuad = new Float32Array(),
) => ({
  status: "cleaned",
  reason: "",
  pixels: new Uint8Array([255]),
  width: 1,
  height: 1,
  skew_degrees: 0,
  content_box: new Uint32Array([0, 0, 1, 1]),
  applied_quad: appliedQuad,
  free,
});

class FakeWorker {
  readonly messageListeners = new Set<
    (event: MessageEvent<WorkerResponse> | ErrorEvent) => void
  >();
  readonly errorListeners = new Set<
    (event: MessageEvent<WorkerResponse> | ErrorEvent) => void
  >();
  terminated = false;
  response: WorkerResponse | undefined;

  constructor(response: WorkerResponse | undefined) {
    this.response = response;
  }

  addEventListener(
    type: "message" | "error",
    listener: (event: MessageEvent<WorkerResponse> | ErrorEvent) => void,
  ) {
    if (type === "message") {
      this.messageListeners.add(listener);
      return;
    }
    this.errorListeners.add(listener);
  }

  removeEventListener(
    type: "message" | "error",
    listener: (event: MessageEvent<WorkerResponse> | ErrorEvent) => void,
  ) {
    if (type === "message") {
      this.messageListeners.delete(listener);
      return;
    }
    this.errorListeners.delete(listener);
  }

  postMessage(_request: WorkerRequest, _transfer: ArrayBuffer[]) {
    if (this.response === undefined) {
      return;
    }
    const response = this.response;
    queueMicrotask(() => {
      const event = new MessageEvent<WorkerResponse>("message", {
        data: response,
      });
      for (const listener of this.messageListeners) {
        listener(event);
      }
    });
  }

  terminate() {
    this.terminated = true;
  }

  emitError(message: string) {
    const event = new ErrorEvent("error", { message });
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }
}

const successfulWorkerResponse = {
  type: "result",
  result: createCleanedWasmResult(() => undefined),
} satisfies WorkerResponse;

describe("worker lifecycle", () => {
  test("times out a stalled worker and recovers with a fresh worker", async () => {
    const stalledWorker = new FakeWorker(undefined);
    const healthyWorker = new FakeWorker(successfulWorkerResponse);
    const workers = [stalledWorker, healthyWorker];
    const engine = createScanEngine(undefined, {
      createWorker: () => {
        const worker = workers.shift();
        if (worker === undefined) {
          throw new Error("No fake worker remains");
        }
        return worker;
      },
      requestTimeoutMs: 1,
    });

    const timedOut = await engine.clean(onePixelPage, options);
    expect(timedOut.isErr()).toBe(true);
    if (timedOut.isOk()) {
      throw new Error("Expected the stalled worker to time out");
    }
    expect(timedOut.error).toMatchObject({ type: "engine-timeout" });
    expect(stalledWorker.terminated).toBe(true);

    expect((await engine.clean(onePixelPage, options)).isOk()).toBe(true);
    expect(healthyWorker.terminated).toBe(false);
  });

  test("fails an invalid worker result and keeps serving later requests", async () => {
    const invalidWorker = new FakeWorker({
      type: "result",
      result: {
        ...successfulWorkerResponse.result,
        width: successfulWorkerResponse.result.width + 1,
      },
    });
    const engine = createScanEngine(undefined, {
      createWorker: () => invalidWorker,
    });

    const failed = await engine.clean(onePixelPage, options);
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) {
      throw new Error("Expected the invalid result to fail");
    }
    expect(failed.error).toMatchObject({
      type: "engine-failure",
      message: "The scan engine returned an invalid pixel buffer",
    });

    invalidWorker.response = successfulWorkerResponse;
    expect((await engine.clean(onePixelPage, options)).isOk()).toBe(true);
  });

  test("removes paired listeners after every worker request", async () => {
    const worker = new FakeWorker(successfulWorkerResponse);
    const engine = createScanEngine(undefined, {
      createWorker: () => worker,
    });

    for (let request = 0; request < 5; request += 1) {
      expect((await engine.clean(onePixelPage, options)).isOk()).toBe(true);
      expect(worker.messageListeners.size).toBe(0);
      expect(worker.errorListeners.size).toBe(0);
    }

    worker.response = undefined;
    const inFlight = engine.clean(onePixelPage, options);
    await Promise.resolve();
    worker.emitError("worker failed");
    const failed = await inFlight;
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) {
      throw new Error("Expected the worker error to fail the request");
    }
    expect(failed.error).toMatchObject({
      type: "engine-failure",
      message: "worker failed",
    });
    expect(worker.messageListeners.size).toBe(0);
    expect(worker.errorListeners.size).toBe(0);
  });
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
  test("maps source-image page corners through unchanged", async () => {
    const sourceQuad = new Float32Array([12, 20, 80, 15, 84, 92, 9, 96]);
    const engine = createScanEngine(async () => ({
      default: async () => undefined,
      clean_scan_rgba: () =>
        createCleanedWasmResult(() => undefined, sourceQuad),
    }));

    const result = (await engine.clean(onePixelPage, options)).unwrap();
    expect(result.type).toBe("cleaned");
    if (result.type !== "cleaned") {
      throw new Error("Expected a cleaned result");
    }
    expect(result.appliedQuad).toEqual({
      topLeft: { x: 12, y: 20 },
      topRight: { x: 80, y: 15 },
      bottomRight: { x: 84, y: 92 },
      bottomLeft: { x: 9, y: 96 },
    });
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
