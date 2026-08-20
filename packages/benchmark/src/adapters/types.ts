import type { GroundTruthDocument } from "../ground-truth";

/**
 * A single detected span in a library's NATIVE label vocabulary. Mapping to the
 * common taxonomy happens later, in one place (`src/metrics.ts` via the
 * taxonomy tables), so every adapter stays a thin, honest wrapper.
 */
export type NativePrediction = {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly text: string;
};

/** Wall-clock timing captured over two full passes of the corpus. */
export type Timing = {
  /** One-time setup not repeated per pass (model load, pipeline build). */
  readonly initSeconds: number;
  /** First full pass over the corpus (includes any lazy first-use cost). */
  readonly coldSeconds: number;
  /** Second full pass over the corpus; not a steady-state guarantee. */
  readonly warmSeconds: number;
  /** Total UTF-16 code units processed in one pass (the scorer's offset unit). */
  readonly totalChars: number;
};

/**
 * Adapter result. `unavailable` records a competitor that could not run
 * locally, with a precise reason, so it is excluded honestly rather than
 * fabricated.
 */
export type AdapterOutcome =
  | {
      readonly status: "ok";
      readonly predictions: ReadonlyMap<string, readonly NativePrediction[]>;
      readonly timing: Timing;
      /** Actual runtime version, when known only at run time (Python libs). */
      readonly reportedVersion?: string | undefined;
      /** Free-form provenance note surfaced in the report (e.g. active detectors). */
      readonly notes?: string | undefined;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export type Adapter = {
  readonly name: string;
  /** Version string of the underlying library, quoted verbatim in the report. */
  readonly version: string;
  readonly run: (
    docs: readonly GroundTruthDocument[],
  ) => Promise<AdapterOutcome>;
};

/** Canonical corpus size used by every adapter and throughput calculation. */
export const totalUtf16CodeUnits = (
  docs: readonly GroundTruthDocument[],
): number => docs.reduce((sum, doc) => sum + doc.text.length, 0);

/**
 * Run a synchronous, in-process detector over the corpus twice and time it.
 * Pass one is "cold" (first touch, lazy init amortised), pass two is "warm".
 * Predictions are taken from the cold pass; both passes must be deterministic.
 */
export const runTwoPassInProcess = (
  docs: readonly GroundTruthDocument[],
  processDoc: (doc: GroundTruthDocument) => NativePrediction[],
  initSeconds: number,
): AdapterOutcome => {
  const totalChars = totalUtf16CodeUnits(docs);
  const predictions = new Map<string, readonly NativePrediction[]>();

  const coldStart = performance.now();
  for (const doc of docs) {
    predictions.set(doc.id, processDoc(doc));
  }
  const coldSeconds = (performance.now() - coldStart) / 1000;

  const warmStart = performance.now();
  for (const doc of docs) {
    processDoc(doc);
  }
  const warmSeconds = (performance.now() - warmStart) / 1000;

  return {
    status: "ok",
    predictions,
    timing: { initSeconds, coldSeconds, warmSeconds, totalChars },
  };
};
