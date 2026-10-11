import { panic } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import initWasm, {
  clean_scan_rgba,
  detect_page_quad_rgba,
} from "../generated/scan_engine.js";
import { scanCornerSuggestion, writeScanQuad } from "./scan-geometry";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const WASM_LOAD_TIMEOUT_MS = 10_000;

const post = (response: WorkerResponse, transfer: ArrayBuffer[] = []) => {
  Reflect.apply(postMessage, globalThis, [response, transfer]);
};

let initialized: Promise<void> | undefined;

const initialize = async () => {
  initialized ??= fetchWithTimeout(
    new URL("../generated/scan_engine_bg.wasm", import.meta.url),
    { timeout: { type: "idle", ms: WASM_LOAD_TIMEOUT_MS } },
  )
    .then(async (response) => await response.arrayBuffer())
    .then(async (module_or_path) => {
      await initWasm({ module_or_path });
      return undefined;
    });
  await initialized;
};

const handle = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    await initialize();
    switch (data.type) {
      case "detect": {
        const values = detect_page_quad_rgba(
          data.page.width,
          data.page.height,
          new Uint8Array(data.pixels),
        );
        const suggestion = scanCornerSuggestion(values, data.page);
        if (suggestion.isErr()) {
          throw suggestion.error;
        }
        post({
          type: "detected",
          suggestion: suggestion.value,
        });
        return;
      }
      case "clean":
        break;
      default:
        panic(
          `Unexpected scan worker request: ${String(data satisfies never)}`,
        );
    }
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
        writeScanQuad(data.options.corners),
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
    post({
      type: "error",
      errorType:
        error instanceof WebAssembly.RuntimeError ? "runtime-trap" : "failure",
      message:
        error instanceof Error ? error.message : "Unknown worker failure",
    });
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
