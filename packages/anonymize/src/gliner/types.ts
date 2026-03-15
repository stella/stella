/**
 * GLiNER inference types.
 *
 * Forked from gliner@0.0.19 (MIT), stripped to runtime-
 * agnostic core. Original: github.com/Ingvarstep/GLiNER.js
 */

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
  ort: unknown;
  init(): Promise<void>;
  run(
    feeds: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};
