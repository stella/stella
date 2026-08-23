import { createHash } from "node:crypto";

import type { NativePrediction } from "../adapters/types";
import type { PerformanceScenario } from "./input";

const PERFORMANCE_LANGUAGE = "en";

export type PerformanceRuntime = {
  readonly type: "bun-native-binding";
  readonly version: string;
};

export type PerformanceSample = {
  readonly scenario: PerformanceScenario;
  readonly runtime: PerformanceRuntime;
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
  readonly outputCount: number;
  readonly outputDigest: string;
  readonly initSeconds: number;
  readonly coldSeconds: number;
  readonly warmSeconds: number;
};

type PerformanceSampleOptions = {
  readonly scenario: PerformanceScenario;
  readonly inputBytes: number;
  readonly inputText: string;
  readonly inputSha256: string;
  readonly initStartedMilliseconds: number;
};

type PerformanceOutput = {
  readonly predictions: readonly NativePrediction[];
  readonly redactedText: string;
};

const outputIdentity = ({
  predictions,
  redactedText,
}: PerformanceOutput): { readonly count: number; readonly digest: string } => {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["redacted-text", redactedText]));
  for (const { start, end, label, text } of predictions) {
    hash.update(JSON.stringify([start, end, label, text]));
  }
  return { count: predictions.length, digest: hash.digest("hex") };
};

export const runPerformanceSample = async ({
  scenario,
  inputBytes,
  inputText,
  inputSha256,
  initStartedMilliseconds,
}: PerformanceSampleOptions): Promise<PerformanceSample> => {
  const anonymize = await import("@stll/anonymize");
  const binding = anonymize.loadNativeAnonymizeBinding();
  const pipeline = anonymize.getDefaultNativePipeline({
    binding,
    language: PERFORMANCE_LANGUAGE,
    warmup: "none",
  });
  const initSeconds = (performance.now() - initStartedMilliseconds) / 1000;

  const detect = (): PerformanceOutput => {
    const result = pipeline.redactText(inputText);
    return {
      redactedText: result.redaction.redactedText,
      predictions: result.resolvedEntities.map(
        ({ start, end, label, text: value }) => ({
          start,
          end,
          label,
          text: value,
        }),
      ),
    };
  };

  const coldStarted = performance.now();
  const cold = detect();
  const coldSeconds = (performance.now() - coldStarted) / 1000;
  const warmStarted = performance.now();
  const warm = detect();
  const warmSeconds = (performance.now() - warmStarted) / 1000;
  const coldIdentity = outputIdentity(cold);
  const warmIdentity = outputIdentity(warm);
  if (
    coldIdentity.count !== warmIdentity.count ||
    coldIdentity.digest !== warmIdentity.digest
  ) {
    throw new Error("cold and warm performance outputs are not deterministic");
  }

  return {
    scenario,
    runtime: { type: "bun-native-binding", version: Bun.version },
    inputBytes,
    inputCharacters: inputText.length,
    inputSha256,
    outputCount: warmIdentity.count,
    outputDigest: warmIdentity.digest,
    initSeconds,
    coldSeconds,
    warmSeconds,
  };
};
