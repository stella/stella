import { createHash } from "node:crypto";

import type { NativePrediction } from "../adapters/types";

const PERFORMANCE_LANGUAGE = "en";

export type PerformanceSample = {
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
  readonly inputBytes: number;
  readonly inputText: string;
  readonly inputSha256: string;
  readonly initStartedMilliseconds: number;
};

const outputIdentity = (
  predictions: readonly NativePrediction[],
): { readonly count: number; readonly digest: string } => {
  const hash = createHash("sha256");
  for (const { start, end, label } of predictions) {
    hash.update(`${start}\0${end}\0${label}\n`);
  }
  return { count: predictions.length, digest: hash.digest("hex") };
};

export const runPerformanceSample = async ({
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

  const detect = (): NativePrediction[] =>
    pipeline
      .redactText(inputText)
      .resolvedEntities.map(({ start, end, label, text: value }) => ({
        start,
        end,
        label,
        text: value,
      }));

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
