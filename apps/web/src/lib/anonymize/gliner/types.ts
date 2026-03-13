/**
 * GLiNER inference types.
 *
 * Forked from gliner@0.0.19 (MIT), stripped to web-only
 * span-level model. Original: github.com/Ingvarstep/GLiNER.js
 */
import type ort from "onnxruntime-web";
import type { InferenceSession } from "onnxruntime-web";

export type ExecutionProvider = "cpu" | "wasm" | "webgpu" | "webgl";

export type OnnxWebSettings = {
  modelPath: string | Uint8Array | ArrayBufferLike;
  executionProvider?: ExecutionProvider;
  wasmPaths?: string;
  multiThread?: boolean;
  maxThreads?: number;
  fetchBinary?: boolean;
};

export type GlinerConfig = {
  tokenizerPath: string;
  onnxSettings: OnnxWebSettings;
  maxWidth?: number;
};

export type InferenceParams = {
  texts: string[];
  entities: string[];
  flatNer?: boolean;
  threshold?: number;
  multiLabel?: boolean;
};

export type EntityResult = {
  spanText: string;
  start: number;
  end: number;
  label: string;
  score: number;
};

/**
 * Raw inference output: per-batch array of
 * [spanText, start, end, label, score] tuples.
 */
export type RawInferenceResult = [string, number, number, string, number][][];

export type OnnxWrapper = {
  ort: typeof ort;
  init(): Promise<void>;
  run(
    feeds: InferenceSession.FeedsType,
    options?: InferenceSession.RunOptions,
  ): Promise<InferenceSession.ReturnType>;
};
