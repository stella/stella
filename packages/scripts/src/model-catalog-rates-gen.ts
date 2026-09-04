#!/usr/bin/env bun

import { Result, TaggedError, panic } from "better-result";
import type { TaggedErrorClass } from "better-result";
import path from "node:path";

import {
  BYOK_MODEL_OPTIONS,
  MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER,
  MODELS_DEV_RATE_SOURCE_ALIASES,
  MODEL_RATE_UNITS_PER_USD,
  normalizeModelCatalogId,
  RETAINED_MODELS_DEV_RATE_ENTRIES,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type {
  BYOKProvider,
  ModelRate,
  ModelRateAmounts,
  ModelsDevRateProvider,
} from "@stll/ai-catalog";

const OUTPUT_PATH = path.resolve(
  import.meta.dir,
  "../../ai-catalog/src/model-rates.gen.ts",
);
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30_000;

const ModelRateGenerationErrorBase: TaggedErrorClass<"ModelRateGenerationError"> =
  TaggedError("ModelRateGenerationError");

class ModelRateGenerationError extends ModelRateGenerationErrorBase<{
  cause?: unknown;
  message: string;
}> {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseModelsDevRateRecords = (
  payload: unknown,
): ReadonlyMap<string, unknown> => {
  if (!isObject(payload)) {
    return panic("models.dev returned a non-object catalog");
  }
  const records = new Map<string, unknown>();
  const wantedProviders: ReadonlySet<string> = new Set(
    Object.values(MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER),
  );
  for (const [provider, providerValue] of Object.entries(payload)) {
    if (!wantedProviders.has(provider)) {
      continue;
    }
    if (!isObject(providerValue) || !isObject(providerValue["models"])) {
      return panic(`models.dev ${provider} catalog has no model map`);
    }
    for (const [modelId, modelValue] of Object.entries(
      providerValue["models"],
    )) {
      records.set(`${provider}:${modelId}`, modelValue);
    }
  }
  return records;
};

type RateSource = {
  modelId: string;
  provider: ModelsDevRateProvider;
  sourceModelId: string;
  sourceReason: string | null;
  sourceUrl: string | null;
};

const providerOptions = (
  provider: Exclude<BYOKProvider, "openrouter">,
): readonly string[] => BYOK_MODEL_OPTIONS[provider];

const buildRateSources = (): RateSource[] => {
  const sources: RateSource[] = [];
  const seen = new Set<string>();
  const sourceAliases: Readonly<
    Record<
      string,
      {
        modelId: string;
        provider: ModelsDevRateProvider;
        reason: string;
        sourceUrl: string;
      }
    >
  > = MODELS_DEV_RATE_SOURCE_ALIASES;

  for (const provider of TANSTACK_AI_PROVIDERS) {
    if (provider === "openrouter") {
      continue;
    }
    const modelsDevProvider =
      MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER[provider];
    for (const modelId of providerOptions(provider)) {
      const alias = sourceAliases[modelId];
      if (alias !== undefined && alias.provider !== modelsDevProvider) {
        return panic(
          `${modelId}: rate-source alias provider ${alias.provider} does not match ${modelsDevProvider}`,
        );
      }
      if (seen.has(modelId)) {
        return panic(`${modelId}: duplicate model-rate target`);
      }
      seen.add(modelId);
      sources.push({
        modelId,
        provider: modelsDevProvider,
        sourceModelId: alias?.modelId ?? modelId,
        sourceReason: alias?.reason ?? null,
        sourceUrl: alias?.sourceUrl ?? null,
      });
    }
  }

  for (const [modelId, source] of Object.entries(
    RETAINED_MODELS_DEV_RATE_ENTRIES,
  )) {
    if (seen.has(modelId)) {
      return panic(`${modelId}: retained rate duplicates an offered model`);
    }
    seen.add(modelId);
    sources.push({
      modelId,
      provider: source.provider,
      sourceModelId: source.modelId,
      sourceReason: null,
      sourceUrl: null,
    });
  }

  const requiredIds = new Set<string>();
  for (const provider of TANSTACK_AI_PROVIDERS) {
    for (const providerModelId of BYOK_MODEL_OPTIONS[provider]) {
      const modelId =
        provider === "openrouter"
          ? providerModelId.slice(providerModelId.indexOf("/") + 1)
          : providerModelId;
      requiredIds.add(normalizeModelCatalogId(modelId));
    }
  }
  const missing = [...requiredIds].filter((modelId) => !seen.has(modelId));
  if (missing.length > 0) {
    return panic(
      `offered models have no models.dev rate source: ${missing.join(", ")}`,
    );
  }
  return sources;
};

const readPositiveNumber = (
  value: unknown,
  source: string,
  field: string,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return panic(`${source}: cost.${field} must be a positive finite number`);
  }
  return value;
};

const readOptionalPositiveNumber = (
  value: unknown,
  source: string,
  field: string,
): number | undefined =>
  value === undefined ? undefined : readPositiveNumber(value, source, field);

const TRACKED_COST_FIELDS = new Set([
  "cache_read",
  "cache_write",
  "input",
  "output",
]);

const assertOnlyKnownCostFields = (
  cost: Record<string, unknown>,
  source: string,
  allowedMetadataFields: ReadonlySet<string>,
): void => {
  const unknownFields = Object.keys(cost).filter(
    (field) =>
      !TRACKED_COST_FIELDS.has(field) && !allowedMetadataFields.has(field),
  );
  if (unknownFields.length > 0) {
    panic(
      `${source}: unsupported models.dev cost fields: ${unknownFields.join(", ")}`,
    );
  }
};

/** Convert a models.dev decimal price without introducing binary FP drift. */
export const modelRateUnitsFromUsd = (value: number): number | undefined => {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const parts = value.toString().toLowerCase().split("e");
  const coefficient = parts.at(0);
  if (coefficient === undefined) {
    return undefined;
  }
  const exponentText = parts.at(1);
  const coefficientParts = coefficient.split(".");
  const integerPart = coefficientParts.at(0);
  if (integerPart === undefined) {
    return undefined;
  }
  const fractionalPart = coefficientParts.at(1) ?? "";
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  let numerator = BigInt(`${integerPart}${fractionalPart}`);
  let denominator = 10n ** BigInt(fractionalPart.length);
  if (exponent > 0) {
    numerator *= 10n ** BigInt(exponent);
  } else if (exponent < 0) {
    denominator *= 10n ** BigInt(-exponent);
  }
  const scaledNumerator = numerator * BigInt(MODEL_RATE_UNITS_PER_USD);
  if (scaledNumerator % denominator !== 0n) {
    return undefined;
  }
  const scaled = scaledNumerator / denominator;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(scaled);
};

const toInternalRate = (
  value: number,
  source: string,
  field: string,
): number => {
  const scaled = modelRateUnitsFromUsd(value);
  if (scaled === undefined) {
    return panic(
      `${source}: cost.${field} does not map to an exact safe integer at ` +
        `${MODEL_RATE_UNITS_PER_USD} units per USD`,
    );
  }
  return scaled;
};

const parseAmounts = (
  cost: Record<string, unknown>,
  source: string,
): ModelRateAmounts => {
  const input = readPositiveNumber(cost["input"], source, "input");
  const output = readPositiveNumber(cost["output"], source, "output");
  const cacheRead = readOptionalPositiveNumber(
    cost["cache_read"],
    source,
    "cache_read",
  );
  const cacheWrite = readOptionalPositiveNumber(
    cost["cache_write"],
    source,
    "cache_write",
  );
  return {
    inputPerMTok: toInternalRate(input, source, "input"),
    outputPerMTok: toInternalRate(output, source, "output"),
    ...(cacheRead === undefined
      ? {}
      : {
          cachedInputPerMTok: toInternalRate(cacheRead, source, "cache_read"),
        }),
    ...(cacheWrite === undefined
      ? {}
      : {
          cachedWriteInputPerMTok: toInternalRate(
            cacheWrite,
            source,
            "cache_write",
          ),
        }),
  };
};

export const modelRateFromModelsDev = (
  modelValue: unknown,
  source: string,
): ModelRate => {
  if (!isObject(modelValue) || !isObject(modelValue["cost"])) {
    return panic(`${source}: models.dev record has no cost object`);
  }
  const cost = modelValue["cost"];
  assertOnlyKnownCostFields(
    cost,
    source,
    new Set(["context_over_200k", "input_audio", "tiers"]),
  );
  // Stella persists audio/video as UI-only output and does not replay it to
  // models, so input_audio is intentionally outside the usage ledger. Still
  // validate the known source field so a schema change cannot pass silently.
  readOptionalPositiveNumber(cost["input_audio"], source, "input_audio");
  const standard = parseAmounts(cost, source);
  const rawTiers = cost["tiers"];
  if (rawTiers === undefined) {
    if (cost["context_over_200k"] !== undefined) {
      return panic(
        `${source}: context_over_200k exists without a supported context tier`,
      );
    }
    return { kind: "flat", ...standard };
  }
  if (!Array.isArray(rawTiers)) {
    return panic(`${source}: cost.tiers must be an array`);
  }
  if (rawTiers.length === 0) {
    if (cost["context_over_200k"] !== undefined) {
      return panic(
        `${source}: context_over_200k exists without a supported context tier`,
      );
    }
    return { kind: "flat", ...standard };
  }
  if (rawTiers.length !== 1) {
    return panic(`${source}: stella supports exactly one context-price tier`);
  }
  const rawTier = rawTiers.at(0);
  if (!isObject(rawTier) || !isObject(rawTier["tier"])) {
    return panic(`${source}: cost.tiers[0] is malformed`);
  }
  assertOnlyKnownCostFields(
    rawTier,
    `${source} context tier`,
    new Set(["tier"]),
  );
  const discriminator = rawTier["tier"];
  const unknownDiscriminatorFields = Object.keys(discriminator).filter(
    (field) => field !== "size" && field !== "type",
  );
  if (unknownDiscriminatorFields.length > 0) {
    return panic(
      `${source}: unsupported context-tier fields: ${unknownDiscriminatorFields.join(", ")}`,
    );
  }
  if (discriminator["type"] !== "context") {
    return panic(
      `${source}: unsupported cost tier ${String(discriminator["type"])}`,
    );
  }
  const threshold = discriminator["size"];
  if (!Number.isSafeInteger(threshold) || Number(threshold) <= 0) {
    return panic(
      `${source}: context tier size must be a positive safe integer`,
    );
  }
  const aboveThreshold = parseAmounts(rawTier, `${source} context tier`);
  const legacyContextRate = cost["context_over_200k"];
  if (legacyContextRate !== undefined) {
    if (!isObject(legacyContextRate)) {
      return panic(`${source}: cost.context_over_200k must be an object`);
    }
    assertOnlyKnownCostFields(
      legacyContextRate,
      `${source} context_over_200k`,
      new Set(),
    );
    const mirrored = parseAmounts(
      legacyContextRate,
      `${source} context_over_200k`,
    );
    if (JSON.stringify(mirrored) !== JSON.stringify(aboveThreshold)) {
      return panic(
        `${source}: cost.context_over_200k disagrees with cost.tiers[0]`,
      );
    }
  }
  return {
    kind: "input-token-tiered",
    inputTokenThreshold: Number(threshold),
    standard,
    aboveThreshold,
  };
};

export type GeneratedModelRateRow = {
  modelId: string;
  rate: ModelRate;
  source: string;
  sourceReason: string | null;
  sourceUrl: string | null;
};

export const buildModelRateRows = (
  upstream: ReadonlyMap<string, unknown>,
): GeneratedModelRateRow[] =>
  buildRateSources().map((spec) => {
    const directKey = `${spec.provider}:${spec.modelId}`;
    const sourceKey = `${spec.provider}:${spec.sourceModelId}`;
    const directValue = upstream.get(directKey);
    if (
      spec.sourceReason !== null &&
      isObject(directValue) &&
      isObject(directValue["cost"]) &&
      typeof directValue["cost"]["input"] === "number" &&
      typeof directValue["cost"]["output"] === "number"
    ) {
      return panic(
        `${spec.modelId}: models.dev now publishes the stella ID directly; ` +
          "delete its rate-source alias",
      );
    }
    const modelValue = upstream.get(sourceKey);
    if (modelValue === undefined) {
      return panic(
        `${spec.modelId}: models.dev rate source ${sourceKey} is absent`,
      );
    }
    return {
      modelId: spec.modelId,
      rate: modelRateFromModelsDev(modelValue, sourceKey),
      source: sourceKey,
      sourceReason: spec.sourceReason,
      sourceUrl: spec.sourceUrl,
    };
  });

const formatInteger = (value: number): string => {
  const digits = String(value);
  if (digits.length <= 4) {
    return digits;
  }

  const firstGroupLength = digits.length % 3 || 3;
  const groups = [digits.slice(0, firstGroupLength)];
  for (let start = firstGroupLength; start < digits.length; start += 3) {
    groups.push(digits.slice(start, start + 3));
  }
  return groups.join("_");
};

const renderAmounts = (
  amounts: ModelRateAmounts,
  indentation: string,
): string[] => [
  `${indentation}inputPerMTok: ${formatInteger(amounts.inputPerMTok)},`,
  `${indentation}outputPerMTok: ${formatInteger(amounts.outputPerMTok)},`,
  ...(amounts.cachedInputPerMTok === undefined
    ? []
    : [
        `${indentation}cachedInputPerMTok: ${formatInteger(amounts.cachedInputPerMTok)},`,
      ]),
  ...(amounts.cachedWriteInputPerMTok === undefined
    ? []
    : [
        `${indentation}cachedWriteInputPerMTok: ${formatInteger(amounts.cachedWriteInputPerMTok)},`,
      ]),
];

const renderRate = (rate: ModelRate): string[] => {
  if (rate.kind === "flat") {
    return ['    kind: "flat",', ...renderAmounts(rate, "    ")];
  }
  return [
    '    kind: "input-token-tiered",',
    `    inputTokenThreshold: ${formatInteger(rate.inputTokenThreshold)},`,
    "    standard: {",
    ...renderAmounts(rate.standard, "      "),
    "    },",
    "    aboveThreshold: {",
    ...renderAmounts(rate.aboveThreshold, "      "),
    "    },",
  ];
};

export const renderModelRatesModule = (
  rows: readonly GeneratedModelRateRow[],
): string => {
  const entries = rows.flatMap((row) => [
    `  // models.dev: ${row.source}`,
    ...(row.sourceReason === null
      ? []
      : [`  // reviewed source mapping: ${row.sourceReason}`]),
    ...(row.sourceUrl === null
      ? []
      : [`  // reviewed source: ${row.sourceUrl}`]),
    `  "${row.modelId}": {`,
    ...renderRate(row.rate),
    "  },",
  ]);
  return `// AUTO-GENERATED by packages/scripts/src/model-catalog-rates-gen.ts.
// Do not edit by hand: regenerate with
// \`bun --filter @stll/ai-catalog gen:rates\`.
//
// Source: https://models.dev/api.json per-model \`cost.input\`,
// \`cost.output\`, \`cost.cache_read\`, \`cost.cache_write\`, and context
// \`cost.tiers\`.
// Modality-specific \`cost.input_audio\` is deliberately excluded because
// stella does not route audio model input. Unknown cost fields fail generation.
// Values are exact integer conversions at ${MODEL_RATE_UNITS_PER_USD} internal
// rate units per models.dev USD per million tokens.
import type { ModelRate } from "./model-rate";

export const MODEL_RATES = {
${entries.join("\n")}
} as const satisfies Readonly<Record<string, ModelRate>>;
`;
};

export const isModelRateSnapshotCurrent = async (
  upstream: ReadonlyMap<string, unknown>,
): Promise<boolean> => {
  const outputFile = Bun.file(OUTPUT_PATH);
  return (
    (await outputFile.exists()) &&
    (await outputFile.text()) ===
      renderModelRatesModule(buildModelRateRows(upstream))
  );
};

const loadModelsDev = async (): Promise<unknown> => {
  const fetched = await Result.tryPromise({
    try: async () => {
      const response = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return {
          status: "error",
          error: new ModelRateGenerationError({
            message: `models.dev responded ${response.status}`,
          }),
        } as const;
      }
      const payload: unknown = await response.json();
      return { status: "success", payload } as const;
    },
    catch: (cause) =>
      cause instanceof ModelRateGenerationError
        ? cause
        : new ModelRateGenerationError({
            cause,
            message: "Failed to fetch or parse the models.dev rate catalog",
          }),
  });
  if (Result.isError(fetched)) {
    return panic(fetched.error.message, fetched.error);
  }
  if (fetched.value.status === "error") {
    return panic(fetched.value.error.message, fetched.value.error);
  }
  return fetched.value.payload;
};

const main = async (): Promise<void> => {
  const checkOnly = Bun.argv.includes("--check");
  const upstream = parseModelsDevRateRecords(await loadModelsDev());
  const rendered = renderModelRatesModule(buildModelRateRows(upstream));
  const outputFile = Bun.file(OUTPUT_PATH);
  const existing = (await outputFile.exists()) ? await outputFile.text() : null;
  if (checkOnly) {
    if (existing === rendered) {
      console.log("model-rates.gen.ts is current with models.dev.");
      return;
    }
    console.error(
      "model-rates.gen.ts is stale; regenerate with " +
        "`bun --filter @stll/ai-catalog gen:rates`.",
    );
    process.exit(1);
  }
  if (existing === rendered) {
    console.log("model-rates.gen.ts unchanged.");
    return;
  }
  await Bun.write(OUTPUT_PATH, rendered);
  console.log(`Wrote ${OUTPUT_PATH}.`);
};

if (import.meta.main) {
  await main();
}
