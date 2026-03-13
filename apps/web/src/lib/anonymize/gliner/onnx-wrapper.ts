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

const ONNX_WASM_CDN =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";

export const createOnnxWrapper = (settings: OnnxWebSettings): OnnxWrapper => {
  const provider = settings.executionProvider ?? "webgpu";
  const wasmPaths = settings.wasmPaths ?? ONNX_WASM_CDN;

  const ort = provider === "webgpu" ? ort_WEBGPU : ort_CPU;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access -- onnxruntime-web env types resolve as any in worker context
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
          // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access -- onnxruntime-web env types resolve as any in worker context
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
