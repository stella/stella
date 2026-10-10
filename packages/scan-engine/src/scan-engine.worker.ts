import initWasm, { clean_scan_rgba } from "../generated/scan_engine.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const post = (response: WorkerResponse, transfer: ArrayBuffer[] = []) => {
  Reflect.apply(postMessage, globalThis, [response, transfer]);
};

let initialized: Promise<void> | undefined;

const initialize = async () => {
  initialized ??= initWasm({
    module_or_path: new URL(
      "../generated/scan_engine_bg.wasm",
      import.meta.url,
    ),
  }).then(() => undefined);
  await initialized;
};

const handle = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    await initialize();
    let result: ReturnType<typeof clean_scan_rgba> | undefined;
    try {
      result = clean_scan_rgba(
        data.page.width,
        data.page.height,
        new Uint8Array(data.pixels),
        data.page.dpi,
        data.options.output,
        data.options.contentCrop === "on",
        data.options.deskew === "on",
      );
      const response: WorkerResponse = {
        type: "result",
        result: {
          status: result.status,
          reason: result.reason,
          pixels: result.pixels,
          width: result.width,
          height: result.height,
          skew_degrees: result.skew_degrees,
          content_box: result.content_box,
          applied_quad: result.applied_quad,
        },
      };
      const buffer = response.result.pixels.buffer;
      post(response, buffer instanceof ArrayBuffer ? [buffer] : []);
    } finally {
      result?.free();
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: "error",
      errorType:
        error instanceof WebAssembly.RuntimeError ? "runtime-trap" : "failure",
      message:
        error instanceof Error ? error.message : "Unknown worker failure",
    };
    post(response);
  }
};

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  handle(event).catch((error: unknown) => {
    post({
      type: "error",
      errorType: "failure",
      message:
        error instanceof Error ? error.message : "Unknown worker failure",
    });
  });
});
