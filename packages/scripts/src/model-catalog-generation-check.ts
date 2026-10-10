import { panic } from "better-result";

import { FIRST_PARTY_MODEL_PROVIDERS } from "@stll/ai-catalog";
import type { FirstPartyModelProvider } from "@stll/ai-catalog";

import { findNewerGenerationModels } from "./model-catalog-discovery";

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

export const readUpstreamIds = (
  snapshot: unknown,
): {
  asOf: string;
  upstreamIds: Record<FirstPartyModelProvider, string[]>;
} => {
  if (!isObject(snapshot)) {
    return panic("models.dev snapshot must be an object");
  }
  const result: Record<FirstPartyModelProvider, string[]> = {
    anthropic: [],
    google: [],
    mistral: [],
    openai: [],
  };
  let asOf = "";
  for (const provider of FIRST_PARTY_MODEL_PROVIDERS) {
    const providerValue = snapshot[provider];
    if (!isObject(providerValue) || !isObject(providerValue["models"])) {
      return panic(`models.dev snapshot is missing ${provider}.models`);
    }
    for (const [modelId, modelValue] of Object.entries(
      providerValue["models"],
    )) {
      result[provider].push(modelId);
      if (!isObject(modelValue)) {
        continue;
      }
      const releaseDate = modelValue["release_date"];
      if (typeof releaseDate === "string" && releaseDate > asOf) {
        asOf = releaseDate;
      }
    }
  }
  if (asOf === "") {
    return panic("models.dev snapshot has no first-party release date");
  }
  return { asOf, upstreamIds: result };
};

const main = async () => {
  const selectedPath = process.argv.includes("--self-test")
    ? fixturePath
    : snapshotPath;
  const snapshot: unknown = await Bun.file(selectedPath).json();
  const failures = findNewerGenerationModels(readUpstreamIds(snapshot));
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
