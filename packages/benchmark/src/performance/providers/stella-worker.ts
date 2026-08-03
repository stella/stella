import { createRequire } from "node:module";

import type { NativePrediction } from "../../adapters/types";
import { assertProviderInputIdentity } from "./input-identity";
import { assertProviderEntities, outputIdentity } from "./identity";
import { regexDetectorConfig } from "./stella-config";
import type { CrossProviderId, ProviderSample } from "./types";

const provider = process.argv.at(2) as CrossProviderId | undefined;
if (provider !== "stella-full" && provider !== "stella-regex-detectors-only") {
  throw new Error("stella performance worker requires a stella provider id");
}

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

const request = (await new Response(Bun.stdin.stream()).json()) as {
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputText: string;
  readonly inputSha256: string;
};
const { inputBytes, inputCharacters, inputSha256 } =
  assertProviderInputIdentity(request, request.inputText);
const initStarted = performance.now();
const anonymize = await import("@stll/anonymize");
const binding = anonymize.loadNativeAnonymizeBinding();
type RedactText = (text: string) => {
  readonly resolvedEntities: readonly {
    readonly start: number;
    readonly end: number;
    readonly label: string;
    readonly text: string;
  }[];
};
let redactText: RedactText;
if (provider === "stella-full") {
  const pipeline = anonymize.getDefaultNativePipeline({
    binding,
    language: "en",
    warmup: "none",
  });
  redactText = (text) => pipeline.redactText(text);
} else {
  const config = {
    threshold: 0.3,
    language: "en",
    nameCorpusLanguages: ["en"],
    enableGazetteer: false,
    labels: [...anonymize.DEFAULT_ENTITY_LABELS],
    workspaceId: `cross-provider-performance-${provider}`,
    enableTriggerPhrases: false,
    enableRegex: true,
    enableLegalForms: false,
    enableNameCorpus: false,
    enableDenyList: false,
    enableCountries: false,
    enableConfidenceBoost: false,
    enableCoreference: false,
    enableHotwordRules: false,
    enableZoneClassification: false,
  };
  const assembled = await anonymize.prepareNativePipelineConfig({
    binding,
    config,
  });
  const prepared = anonymize.createNativeAnonymizerFromConfig({
    binding,
    config: regexDetectorConfig(assembled),
  });
  redactText = (text) => prepared.redactStaticEntities(text);
}
const initSeconds = (performance.now() - initStarted) / 1000;

const detect = (): NativePrediction[] =>
  redactText(request.inputText).resolvedEntities.map(
    ({ start, end, label, text }) => ({
      start,
      end,
      label,
      text,
    }),
  );

const firstCallStarted = performance.now();
const firstCall = detect();
const firstCallSeconds = (performance.now() - firstCallStarted) / 1000;
const secondCallStarted = performance.now();
const secondCall = detect();
const secondCallSeconds = (performance.now() - secondCallStarted) / 1000;
assertProviderEntities(firstCall, request.inputText.length);
assertProviderEntities(secondCall, request.inputText.length);
const firstCallIdentity = outputIdentity(firstCall);
const secondCallIdentity = outputIdentity(secondCall);
if (
  firstCallIdentity.count !== secondCallIdentity.count ||
  firstCallIdentity.digest !== secondCallIdentity.digest
) {
  throw new Error("stella first-call and second-call outputs differ");
}

const require = createRequire(import.meta.url);
const version = (
  require("@stll/anonymize/package.json") as { readonly version: string }
).version;
const processCpuUsage = process.cpuUsage();
const sample: ProviderSample = {
  provider,
  providerVersion: version,
  runtimeVersion: `Bun ${Bun.version}`,
  scope: provider === "stella-full" ? "full-pipeline" : "regex-detectors-only",
  inputBytes,
  inputCharacters,
  inputSha256,
  outputCount: secondCallIdentity.count,
  outputDigest: secondCallIdentity.digest,
  outputLabelCounts: secondCallIdentity.labelCounts,
  initSeconds,
  firstCallSeconds,
  secondCallSeconds,
  processCpuSeconds:
    (processCpuUsage.user + processCpuUsage.system) / 1_000_000,
};
process.stdout.write(`${JSON.stringify({ type: "result", sample })}\n`);
