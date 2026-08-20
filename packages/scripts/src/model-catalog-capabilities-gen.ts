import { panic } from "better-result";
/**
 * Generates `packages/ai-catalog/src/capabilities.gen.ts` — the
 * per-model document-input, reasoning-effort, and temperature policy maps
 * from models.dev plus reviewed provider corrections and policy cutovers.
 *
 * Rules enforced here (each one turns a class of catalog mistakes
 * into a loud generation failure):
 *  - every offered BYOK model must be covered by upstream data or by
 *    an explicit dated override (`capabilities-overrides.ts`);
 *  - an override for a model the upstream source covers is rejected,
 *    so manual data can never shadow sourced data;
 *  - document-input support follows live modality metadata unless a dated
 *    source correction exists, and a correction is rejected once upstream
 *    agrees;
 *  - an upstream effort keyword outside the `REASONING_EFFORTS`
 *    ladder is rejected, forcing a reviewed ladder extension.
 *
 * The emitted module keeps the compile-time exhaustiveness guarantee
 * (`satisfies Record<OfferedBYOKModelId, …>`): offering a new model
 * without regenerating fails typecheck, and regenerating pulls the
 * new model's capabilities from the source.
 *
 * Usage:
 *   bun packages/scripts/src/model-catalog-capabilities-gen.ts
 *   bun packages/scripts/src/model-catalog-capabilities-gen.ts --check
 */
import path from "node:path";

import {
  BYOK_MODEL_OPTIONS,
  CAPABILITY_OVERRIDES,
  DOCUMENT_INPUT_OVERRIDES,
  REASONING_EFFORTS,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type {
  BYOKProvider,
  CapabilityOverride,
  DocumentInputOverride,
  ReasoningEffort,
  TemperaturePolicy,
} from "@stll/ai-catalog";

import {
  parseOpenRouterReasoningDefaults,
  parseUpstreamCapabilities,
  resolveTemperaturePolicy,
} from "./model-catalog-capabilities";
import type {
  OpenRouterReasoningDefaults,
  UpstreamCapabilities,
} from "./model-catalog-capabilities";

const OUTPUT_PATH = path.resolve(
  import.meta.dir,
  "../../ai-catalog/src/capabilities.gen.ts",
);

/** Catalog provider → models.dev provider key. */
const MODELS_DEV_KEY_BY_PROVIDER: Record<
  keyof typeof BYOK_MODEL_OPTIONS,
  string
> = {
  google: "google",
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  bedrock: "amazon-bedrock",
  mistral: "mistral",
};

const REASONING_EFFORT_LADDER: readonly string[] = REASONING_EFFORTS;

const isReasoningEffort = (value: string): value is ReasoningEffort =>
  REASONING_EFFORT_LADDER.includes(value);

// Widened views for runtime-string lookups.
const OVERRIDE_BY_ID: Partial<Record<string, CapabilityOverride>> =
  CAPABILITY_OVERRIDES;
const DOCUMENT_INPUT_OVERRIDE_BY_ID: Partial<
  Record<string, DocumentInputOverride>
> = DOCUMENT_INPUT_OVERRIDES;

export type CapabilityRow = {
  defaultReasoningEffort: ReasoningEffort | null;
  documentInput: boolean;
  documentInputOverrideReason: string | null;
  modelId: string;
  provider: BYOKProvider;
  efforts: readonly ReasoningEffort[] | null;
  temperaturePolicy: TemperaturePolicy;
  overrideReason: string | null;
};

export type BuildCapabilityRowsOptions = {
  /** OpenRouter model id → the concrete effort used when omitted. */
  openRouterDefaults: OpenRouterReasoningDefaults;
  /** `${modelsDevKey}:${modelId}` → upstream capability metadata. */
  upstream: ReadonlyMap<string, UpstreamCapabilities>;
};

/**
 * Resolve every offered BYOK model to a capability row, in catalog
 * declaration order. Throws with an actionable message on any gap or
 * conflict; a successful run proves full sourced coverage.
 */
export const buildCapabilityRows = ({
  openRouterDefaults,
  upstream,
}: BuildCapabilityRowsOptions): CapabilityRow[] => {
  const rows: CapabilityRow[] = [];
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const mdKey = MODELS_DEV_KEY_BY_PROVIDER[provider];
    for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
      const record = upstream.get(`${mdKey}:${modelId}`);
      const override = OVERRIDE_BY_ID[modelId];
      const documentInputOverride = DOCUMENT_INPUT_OVERRIDE_BY_ID[modelId];
      if (record !== undefined && override !== undefined) {
        panic(
          `${provider}/${modelId}: override present but models.dev covers ` +
            "this model; delete the override so sourced data wins",
        );
      }
      if (record === undefined) {
        if (override === undefined) {
          return panic(
            `${provider}/${modelId}: absent from models.dev (${mdKey}) and ` +
              "no CAPABILITY_OVERRIDES entry; add a dated override or drop " +
              "the model",
          );
        }
        rows.push({
          defaultReasoningEffort: null,
          documentInput: override.documentInput,
          documentInputOverrideReason: override.documentInputReason,
          modelId,
          provider,
          efforts: override.reasoningEfforts,
          temperaturePolicy: override.temperatureSupported ? "emit" : "omit",
          overrideReason: override.reason,
        });
        continue;
      }
      const effortValues = record.reasoning ? record.effortValues : null;
      let efforts: ReasoningEffort[] | null = null;
      if (effortValues !== null) {
        efforts = [];
        for (const value of effortValues) {
          if (!isReasoningEffort(value)) {
            return panic(
              `${provider}/${modelId}: upstream effort "${value}" is not in ` +
                "the REASONING_EFFORTS ladder; extend the ladder (reviewed " +
                "type change) before regenerating",
            );
          }
          efforts.push(value);
        }
      }
      if (record.temperature === null) {
        return panic(
          `${provider}/${modelId}: models.dev record lacks the temperature ` +
            "field; investigate upstream before regenerating",
        );
      }
      if (
        record.inputModalities === null &&
        documentInputOverride === undefined
      ) {
        return panic(
          `${provider}/${modelId}: models.dev record lacks modalities.input; ` +
            "add a dated DOCUMENT_INPUT_OVERRIDES entry before regenerating",
        );
      }
      const upstreamDocumentInput =
        record.inputModalities?.includes("pdf") ?? false;
      if (
        documentInputOverride !== undefined &&
        record.inputModalities !== null &&
        documentInputOverride.supported === upstreamDocumentInput
      ) {
        return panic(
          `${provider}/${modelId}: document-input override now agrees with ` +
            "models.dev; delete the override so sourced data wins",
        );
      }
      const openRouterDefault =
        provider === "openrouter" ? openRouterDefaults.get(modelId) : undefined;
      if (
        openRouterDefault !== undefined &&
        !isReasoningEffort(openRouterDefault)
      ) {
        return panic(
          `${provider}/${modelId}: OpenRouter default effort ` +
            `"${openRouterDefault}" is not in the REASONING_EFFORTS ladder`,
        );
      }
      if (
        provider === "openrouter" &&
        efforts !== null &&
        openRouterDefault === undefined
      ) {
        return panic(
          `${provider}/${modelId}: OpenRouter exposes effort control but ` +
            "publishes no default_effort",
        );
      }
      if (
        openRouterDefault !== undefined &&
        (efforts === null || !efforts.includes(openRouterDefault))
      ) {
        return panic(
          `${provider}/${modelId}: OpenRouter default effort ` +
            `"${openRouterDefault}" is absent from its supported effort set`,
        );
      }
      rows.push({
        defaultReasoningEffort: openRouterDefault ?? null,
        documentInput:
          documentInputOverride?.supported ?? upstreamDocumentInput,
        documentInputOverrideReason: documentInputOverride?.reason ?? null,
        modelId,
        provider,
        efforts,
        temperaturePolicy: resolveTemperaturePolicy({
          modelId,
          provider,
          releaseDate: record.releaseDate,
          upstreamSupportsTemperature: record.temperature,
        }),
        overrideReason: null,
      });
    }
  }
  return rows;
};

const renderEfforts = (efforts: readonly ReasoningEffort[] | null): string =>
  efforts === null
    ? "null"
    : `[${efforts.map((effort) => `"${effort}"`).join(", ")}]`;

const renderDefaultEffort = (effort: ReasoningEffort | null): string =>
  effort === null ? "null" : `"${effort}"`;

/** Render the generated module source. Deterministic for stable diffs. */
export const renderCapabilitiesModule = (rows: CapabilityRow[]): string => {
  const effortLines = rows.map((row) => {
    const comment =
      row.overrideReason === null
        ? ""
        : `  // override: ${row.overrideReason}\n`;
    return `${comment}  "${row.modelId}": ${renderEfforts(row.efforts)},`;
  });
  const temperaturePolicyLines = rows.map(
    (row) => `  "${row.modelId}": "${row.temperaturePolicy}",`,
  );
  const defaultEffortLines = rows.map(
    (row) =>
      `  "${row.modelId}": ${renderDefaultEffort(row.defaultReasoningEffort)},`,
  );
  const documentInputProviderLines = TANSTACK_AI_PROVIDERS.map((provider) => {
    const modelLines = rows
      .filter((row) => row.provider === provider && row.documentInput)
      .map((row) => {
        const comment =
          row.documentInputOverrideReason === null
            ? ""
            : `    // override: ${row.documentInputOverrideReason}\n`;
        return `${comment}    "${row.modelId}",`;
      });
    if (modelLines.length === 0) {
      return `  ${provider}: [],`;
    }
    return `  ${provider}: [\n${modelLines.join("\n")}\n  ],`;
  });
  return `// AUTO-GENERATED by packages/scripts/src/model-catalog-capabilities-gen.ts.
// Do not edit by hand: regenerate with
// \`bun --filter @stll/ai-catalog gen:capabilities\`.
//
// Sources: models.dev per-model \`reasoning_options\`, \`temperature\`,
// \`modalities.input\`, and release dates (first-party, openrouter, and
// amazon-bedrock catalogs);
// OpenRouter's public per-model \`default_effort\`; plus reviewed provider
// policies and dated entries from capabilities-overrides.ts and
// document-input-overrides.ts.
// The nightly \`model-catalog-upstream\` check fails CI on unsafe drift.
import type {
  BYOKModelIdByProvider,
  BYOKProvider,
  OfferedBYOKModelId,
  ReasoningEffort,
  TemperaturePolicy,
} from "./index";

/**
 * Offered models whose provider API accepts PDF/file content. Generated from
 * live input-modality metadata plus reviewed source corrections.
 */
export const MODEL_DOCUMENT_INPUT_OPTIONS = {
${documentInputProviderLines.join("\n")}
} as const satisfies {
  [TProvider in BYOKProvider]: readonly BYOKModelIdByProvider[TProvider][];
};

/**
 * Reasoning-effort values each offered model accepts, \`null\` when the
 * model exposes no effort-style reasoning control. A missing \`"none"\`
 * means the model's reasoning cannot be disabled; consumers must go
 * through \`resolveReasoningEffort\`.
 */
export const MODEL_REASONING_EFFORTS = {
${effortLines.join("\n")}
} as const satisfies Record<
  OfferedBYOKModelId,
  readonly ReasoningEffort[] | null
>;

/**
 * Concrete provider-default effort where the upstream catalogue publishes
 * one. OpenRouter is the source today; null means the provider does not expose
 * a truthful named default, so clients must retain a separate Default choice.
 */
export const MODEL_DEFAULT_REASONING_EFFORTS = {
${defaultEffortLines.join("\n")}
} as const satisfies Record<
  OfferedBYOKModelId,
  ReasoningEffort | null
>;

/**
 * Whether stella should emit a \`temperature\` sampling override.
 * \`"omit"\` covers rejected, deprecated, and accepted-but-ignored
 * parameters. Consumers must go through \`shouldEmitTemperature\`.
 */
export const MODEL_TEMPERATURE_POLICIES = {
${temperaturePolicyLines.join("\n")}
} as const satisfies Record<OfferedBYOKModelId, TemperaturePolicy>;
`;
};

const loadUpstream = async (): Promise<
  ReadonlyMap<string, UpstreamCapabilities>
> => {
  const response = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    panic(`models.dev responded ${response.status}`);
  }
  const body: unknown = await response.json();
  const upstream = new Map<string, UpstreamCapabilities>();
  if (typeof body !== "object" || body === null) {
    return upstream;
  }
  const wanted = new Set(Object.values(MODELS_DEV_KEY_BY_PROVIDER));
  for (const [providerKey, providerVal] of Object.entries(body)) {
    if (!wanted.has(providerKey)) {
      continue;
    }
    if (
      typeof providerVal !== "object" ||
      providerVal === null ||
      !("models" in providerVal) ||
      typeof providerVal.models !== "object" ||
      providerVal.models === null
    ) {
      continue;
    }
    for (const [modelId, modelVal] of Object.entries(providerVal.models)) {
      const parsed = parseUpstreamCapabilities(modelVal);
      if (parsed !== null) {
        upstream.set(`${providerKey}:${modelId}`, parsed);
      }
    }
  }
  return upstream;
};

const loadOpenRouterDefaults =
  async (): Promise<OpenRouterReasoningDefaults> => {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      panic(`OpenRouter responded ${response.status}`);
    }
    return parseOpenRouterReasoningDefaults(await response.json());
  };

const main = async (): Promise<void> => {
  const checkOnly = Bun.argv.includes("--check");
  const [upstream, openRouterDefaults] = await Promise.all([
    loadUpstream(),
    loadOpenRouterDefaults(),
  ]);
  const rows = buildCapabilityRows({ openRouterDefaults, upstream });
  const rendered = renderCapabilitiesModule(rows);
  // A missing generated file is the "stale" answer this check is asking for,
  // so it is tested for rather than caught: a blanket catch would report a
  // permissions or I/O failure as staleness and send the reader to regenerate
  // a file they cannot read.
  const outputFile = Bun.file(OUTPUT_PATH);
  const existing = (await outputFile.exists()) ? await outputFile.text() : null;
  if (checkOnly) {
    if (existing === rendered) {
      console.log("capabilities.gen.ts is current.");
      return;
    }
    console.error(
      "capabilities.gen.ts is stale; regenerate with " +
        "`bun --filter @stll/ai-catalog gen:capabilities`.",
    );
    process.exit(1);
  }
  if (existing === rendered) {
    console.log("capabilities.gen.ts unchanged.");
    return;
  }
  await Bun.write(OUTPUT_PATH, rendered);
  console.log(`Wrote ${OUTPUT_PATH} (${rows.length} models).`);
};

if (import.meta.main) {
  await main();
}
