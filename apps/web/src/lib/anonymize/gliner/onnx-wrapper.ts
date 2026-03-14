// TODO: FIXME — onnxruntime-web types resolve as error/any in web worker context
/**
 * ONNX Runtime web wrapper.
 *
 * Handles execution provider selection (WebGPU, WASM)
 * and session lifecycle. Runs inside a Web Worker.
 */
import ort_CPU from "onnxruntime-web";
import type { InferenceSession } from "onnxruntime-web";
import ort_WEBGPU from "onnxruntime-web/webgpu";

import type { OnnxWebSettings, OnnxWrapper } from "./types";

/**
 * Derive the CDN base URL for WASM files from the installed
 * onnxruntime-web version. In dev mode Vite cannot serve WASM
 * from node_modules, so we load them from jsdelivr instead.
 * The version is read from the package at build time via
 * ort_CPU.env so it stays in sync automatically.
 */
const resolveWasmPaths = (): string => {
  // ort.env.versions?.web gives the runtime version string
  // in onnxruntime-web >=1.17
  const version = ort_CPU.env.versions?.web;
  if (version) {
    return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
  }
  // Fallback: use the pinned installed version
  return "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
};

export const createOnnxWrapper = (settings: OnnxWebSettings): OnnxWrapper => {
  const provider = settings.executionProvider ?? "webgpu";
  const wasmPaths = settings.wasmPaths ?? resolveWasmPaths();

  const ort = provider === "webgpu" ? ort_WEBGPU : ort_CPU;
  ort.env.wasm.wasmPaths = wasmPaths;

  // oxlint-disable-next-line typescript-eslint/no-redundant-type-constituents -- InferenceSession resolves to error type in web worker context
  let session: InferenceSession | null = null;

  return {
    ort,

    async init() {
      // oxlint-disable-next-line typescript-eslint/strict-boolean-expressions -- session typed as InferenceSession|null
      if (session) {
        return;
      }

      if (provider === "cpu" || provider === "wasm") {
        if (settings.fetchBinary) {
          const binaryURL = `${wasmPaths}ort-wasm-simd-threaded.wasm`;
          const response = await fetch(binaryURL);
          const binary = await response.arrayBuffer();
          // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access -- onnxruntime-web env types resolve as any in worker context
          ort.env.wasm.wasmBinary = binary;
        }

        if (settings.multiThread) {
          const maxPossible = navigator.hardwareConcurrency ?? 0;
          ort.env.wasm.numThreads = Math.min(
            settings.maxThreads ?? maxPossible,
            maxPossible,
          );
        }
      }

      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access -- onnxruntime-web types resolve as any in worker context
      session = await ort.InferenceSession.create(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- ONNX accepts string | Uint8Array | ArrayBuffer
        settings.modelPath as string,
        { executionProviders: [provider] },
      );
    },

    // oxlint-disable-next-line require-await -- returns session.run() promise directly
    async run(
      feeds: InferenceSession.FeedsType,
      options: InferenceSession.RunOptions = {},
    ) {
      // oxlint-disable-next-line typescript-eslint/strict-boolean-expressions -- session typed as InferenceSession|null
      if (!session) {
        throw new Error("ONNX session not initialised. Call init() first.");
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-return, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access -- onnxruntime-web types resolve as any in worker context
      return session.run(feeds, options);
    },
  };
};
