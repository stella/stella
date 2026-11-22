import { existsSync, readFileSync } from "node:fs";

import {
  decode_heic_preview,
  initSync,
  type WasmHeicPreview,
} from "../generated/heic_decoder.js";

/** File name of the WebAssembly module, which a bundle ships beside itself. */
export const HEIC_DECODER_WASM_FILE = "heic_decoder_bg.wasm";

/**
 * Where the module is: beside the running file when this code is bundled
 * (the host copies it there, as it does other WebAssembly sidecars), else in
 * this package's `generated/` directory.
 */
export const heicDecoderWasmUrl = (): URL => {
  const sidecar = new URL(HEIC_DECODER_WASM_FILE, import.meta.url);
  return existsSync(sidecar)
    ? sidecar
    : new URL(`../generated/${HEIC_DECODER_WASM_FILE}`, import.meta.url);
};

export type HeicPreviewLimits = {
  /** Pixels the decoded image may hold; a file declaring more is refused. */
  maxDecodedPixels: number;
  /** Pixels of the returned image; a larger one is scaled down to fit. */
  maxOutputPixels: number;
};

/**
 * - `decoded`: 8-bit sRGB RGBA pixels, rotation and mirroring applied.
 * - `too-large`: the file declares an image above `maxDecodedPixels`, or a
 *   grid of tiles that holds far more pixels than it shows.
 * - `unreadable`: not a HEIF file this decoder reads, or a damaged one.
 * - `failed`: the decoder stopped (its memory limit, or a defect in it).
 *   Its instance is discarded; the next call loads a fresh one.
 */
export type HeicPreview =
  | { type: "decoded"; width: number; height: number; rgba: Uint8Array }
  | { type: "too-large" }
  | { type: "unreadable" }
  | { type: "failed"; message: string };

export type HeicDecoder = {
  decode: (bytes: Uint8Array, limits: HeicPreviewLimits) => HeicPreview;
};

/**
 * A decoder backed by the WebAssembly module at `wasmPath` (by default
 * `heicDecoderWasmUrl()`), loaded on the first call. Decoding is synchronous
 * and single-threaded: run it where blocking is fine (a worker process),
 * never on a request path.
 */
export const createHeicDecoder = (
  wasmPath: string | URL = heicDecoderWasmUrl(),
): HeicDecoder => {
  let loaded = false;
  const load = () => {
    if (!loaded) {
      initSync({ module: readFileSync(wasmPath) });
      loaded = true;
    }
  };
  return {
    decode: (bytes, { maxDecodedPixels, maxOutputPixels }) => {
      // The module refuses (throws) limits that are not positive integers.
      load();
      let result: WasmHeicPreview | undefined;
      try {
        result = decode_heic_preview(bytes, maxDecodedPixels, maxOutputPixels);
        const status = result.status;
        switch (status) {
          case "decoded": {
            return {
              type: "decoded",
              width: result.width,
              height: result.height,
              rgba: result.take_rgba(),
            };
          }
          case "too-large":
          case "unreadable": {
            return { type: status };
          }
          default: {
            return {
              type: "failed",
              message: `Unknown decoder status: ${status}`,
            };
          }
        }
      } catch (error) {
        if (!(error instanceof WebAssembly.RuntimeError)) {
          throw error;
        }
        // A trap leaves the instance's memory in an unknown state.
        loaded = false;
        result = undefined;
        return { type: "failed", message: error.message };
      } finally {
        result?.free();
      }
    },
  };
};
