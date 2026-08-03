import type { OpenRedaction as OpenRedactionDetector } from "@openredaction/core";

import type { GroundTruthDocument } from "../ground-truth";
import {
  totalUtf16CodeUnits,
  type Adapter,
  type NativePrediction,
} from "./types";

const OPENREDACTION_VERSION = "1.1.5";

type OpenRedactionConstructor = new (options: {
  readonly enableLearning: false;
  readonly enableNER: false;
}) => OpenRedactionDetector;

const OPENREDACTION_BENCHMARK_OPTIONS = {
  enableLearning: false,
  enableNER: false,
} as const;

/** Disable the package's working-directory learning store for reproducible runs. */
export const createStatelessOpenRedaction = (
  Detector: OpenRedactionConstructor,
): OpenRedactionDetector => new Detector(OPENREDACTION_BENCHMARK_OPTIONS);

const detectDocument = async (
  detector: OpenRedactionDetector,
  { text }: GroundTruthDocument,
): Promise<NativePrediction[]> => {
  const { detections } = await detector.detect(text);
  return detections.map(({ position: [start, end], type, value }) => {
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(end) ||
      end <= start ||
      end > text.length ||
      text.slice(start, end) !== value
    ) {
      throw new Error("openredaction returned an invalid entity span");
    }
    return { start, end, label: type, text: value };
  });
};

export const createOpenRedactionAdapter = (): Adapter => ({
  name: "openredaction",
  version: OPENREDACTION_VERSION,
  run: async (docs: readonly GroundTruthDocument[]) => {
    const initStart = performance.now();
    // Use the pinned package's local regex detector with heuristic context
    // processing. Its disk-backed learning store is disabled explicitly so
    // local files cannot alter development or sealed predictions.
    // Optional NER is deliberately not enabled: it requires an undeclared,
    // English-only dependency and would not be reproducible across languages.
    const { OpenRedaction } = await import("@openredaction/core");
    const detector = createStatelessOpenRedaction(OpenRedaction);
    const patternCount = detector.getPatterns().length;
    const initSeconds = (performance.now() - initStart) / 1000;

    const predictions = new Map<string, readonly NativePrediction[]>();
    const coldStart = performance.now();
    for (const doc of docs) {
      predictions.set(doc.id, await detectDocument(detector, doc));
    }
    const coldSeconds = (performance.now() - coldStart) / 1000;

    const warmStart = performance.now();
    for (const doc of docs) {
      const warmPredictions = await detectDocument(detector, doc);
      if (
        JSON.stringify(warmPredictions) !==
        JSON.stringify(predictions.get(doc.id))
      ) {
        throw new Error("openredaction returned non-deterministic predictions");
      }
    }
    const warmSeconds = (performance.now() - warmStart) / 1000;

    return {
      status: "ok",
      predictions,
      timing: {
        initSeconds,
        coldSeconds,
        warmSeconds,
        totalChars: totalUtf16CodeUnits(docs),
      },
      notes: `${patternCount} built-in regex patterns; stateless local configuration; learning and NER disabled`,
    };
  },
});
