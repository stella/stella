import { panic } from "better-result";

import { FIRST_PARTY_MODEL_PROVIDERS } from "@stll/ai-catalog";
import type { FirstPartyModelProvider } from "@stll/ai-catalog";
import { Temporal } from "@stll/time";

import { findNewerGenerationModels } from "./model-catalog-discovery";
import type {
  FindNewerGenerationModelsOptions,
  GenerationGuardFailure,
} from "./model-catalog-discovery";

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
  offered?: FindNewerGenerationModelsOptions["offered"];
};

export const checkSnapshotGenerations = ({
  snapshot,
  today,
  exclusions,
  offered,
}: CheckSnapshotGenerationsOptions) =>
  findNewerGenerationModels({
    upstreamIds: readUpstreamIds(snapshot),
    asOf: today,
    ...(exclusions === undefined ? {} : { exclusions }),
    ...(offered === undefined ? {} : { offered }),
  });

// The planted snapshot holds exactly one newer generation of this fixed
// baseline, so upgrading the live catalog cannot change the self-test.
export const SELF_TEST_OFFERED = {
  anthropic: ["claude-haiku-5-5"],
  google: [],
  mistral: [],
  openai: [],
} as const satisfies FindNewerGenerationModelsOptions["offered"];
export const PLANTED_FAILURE = "newer-generation: anthropic:claude-haiku-5-6";

export const formatFailure = ({
  type,
  provider,
  modelId,
}: GenerationGuardFailure) => `${type}: ${provider}:${modelId}`;

const main = async () => {
  const selfTest = process.argv.includes("--self-test");
  const snapshot: unknown = await Bun.file(
    selfTest ? fixturePath : snapshotPath,
  ).json();
  const failures = checkSnapshotGenerations({
    snapshot,
    today: Temporal.Now.plainDateISO("UTC").toString(),
    ...(selfTest ? { offered: SELF_TEST_OFFERED } : {}),
  });
  if (selfTest) {
    const reported = failures.map(formatFailure);
    if (reported.length === 1 && reported[0] === PLANTED_FAILURE) {
      console.log("Model generation guard self-test passed.");
      return;
    }
    console.error(
      `Model generation guard self-test expected only ${PLANTED_FAILURE}, got: ${reported.join(", ") || "none"}`,
    );
    process.exitCode = 1;
    return;
  }
  if (failures.length === 0) {
    console.log(
      "Model generation guard passed: no unreviewed newer generations.",
    );
    return;
  }
  console.error("Model generation guard failed:");
  for (const failure of failures) {
    console.error(`  ${formatFailure(failure)}`);
  }
  process.exitCode = 1;
};

if (import.meta.main) {
  await main();
}
