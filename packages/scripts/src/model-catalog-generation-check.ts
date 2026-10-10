import { panic } from "better-result";

import { FIRST_PARTY_MODEL_PROVIDERS } from "@stll/ai-catalog";
import type { FirstPartyModelProvider } from "@stll/ai-catalog";
import { Temporal } from "@stll/time";

import { findNewerGenerationModels } from "./model-catalog-discovery";
import type { FindNewerGenerationModelsOptions } from "./model-catalog-discovery";

const snapshotPath = new URL(
  "../../ai-catalog/upstream/models.dev.gen.json",
  import.meta.url,
);
const fixturePath = new URL(
  "../fixtures/model-catalog-newer-generation.json",
  import.meta.url,
);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readUpstreamIds = (
  snapshot: unknown,
): Record<FirstPartyModelProvider, string[]> => {
  if (!isObject(snapshot)) {
    return panic("models.dev snapshot must be an object");
  }
  const result: Record<FirstPartyModelProvider, string[]> = {
    anthropic: [],
    google: [],
    mistral: [],
    openai: [],
  };
  for (const provider of FIRST_PARTY_MODEL_PROVIDERS) {
    const providerValue = snapshot[provider];
    if (!isObject(providerValue) || !isObject(providerValue["models"])) {
      return panic(`models.dev snapshot is missing ${provider}.models`);
    }
    result[provider].push(...Object.keys(providerValue["models"]));
  }
  return result;
};

type CheckSnapshotGenerationsOptions = {
  snapshot: unknown;
  // Exclusions expire on the calendar, not on the snapshot's newest release.
  today: string;
  exclusions?: FindNewerGenerationModelsOptions["exclusions"];
};

export const checkSnapshotGenerations = ({
  snapshot,
  today,
  exclusions,
}: CheckSnapshotGenerationsOptions) =>
  findNewerGenerationModels({
    upstreamIds: readUpstreamIds(snapshot),
    asOf: today,
    ...(exclusions === undefined ? {} : { exclusions }),
  });

const main = async () => {
  const selectedPath = process.argv.includes("--self-test")
    ? fixturePath
    : snapshotPath;
  const snapshot: unknown = await Bun.file(selectedPath).json();
  const failures = checkSnapshotGenerations({
    snapshot,
    today: Temporal.Now.plainDateISO("UTC").toString(),
  });
  if (failures.length === 0) {
    console.log(
      "Model generation guard passed: no unreviewed newer generations.",
    );
    return;
  }
  console.error("Model generation guard failed:");
  for (const failure of failures) {
    console.error(`  ${failure.type}: ${failure.provider}:${failure.modelId}`);
  }
  process.exitCode = 1;
};

if (import.meta.main) {
  await main();
}
