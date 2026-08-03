import { createRequire } from "node:module";

import { createStatelessOpenRedaction } from "../../adapters/openredaction";
import { assertProviderInputIdentity } from "./input-identity";
import { assertProviderEntities, outputIdentity } from "./identity";
import type { ProviderSample } from "./types";

const PROVIDER = "openredaction-default" as const;

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
const { OpenRedaction } = await import("@openredaction/core");
const detector = createStatelessOpenRedaction(OpenRedaction);
const initSeconds = (performance.now() - initStarted) / 1000;

const detect = async () => {
  const { detections } = await detector.detect(request.inputText);
  return detections.map(({ position: [start, end], type, value }) => {
    if (request.inputText.slice(start, end) !== value) {
      throw new Error("OpenRedaction returned a span/value mismatch");
    }
    return { start, end, label: type };
  });
};

const firstCallStarted = performance.now();
const firstCall = await detect();
const firstCallSeconds = (performance.now() - firstCallStarted) / 1000;
const secondCallStarted = performance.now();
const secondCall = await detect();
const secondCallSeconds = (performance.now() - secondCallStarted) / 1000;

assertProviderEntities(firstCall, request.inputText.length);
assertProviderEntities(secondCall, request.inputText.length);
const firstCallIdentity = outputIdentity(firstCall);
const secondCallIdentity = outputIdentity(secondCall);
if (
  firstCallIdentity.count !== secondCallIdentity.count ||
  firstCallIdentity.digest !== secondCallIdentity.digest
) {
  throw new Error("OpenRedaction first-call and second-call outputs differ");
}

const require = createRequire(import.meta.url);
const providerVersion = (
  require("@openredaction/core/package.json") as {
    readonly version: string;
  }
).version;
const processCpuUsage = process.cpuUsage();
const sample: ProviderSample = {
  provider: PROVIDER,
  providerVersion,
  runtimeVersion: `Bun ${Bun.version}`,
  scope: "base-install",
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
