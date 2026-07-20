import { panic } from "better-result";
/**
 * Generates `packages/ai-catalog/src/capabilities.gen.ts` — the
 * per-model reasoning-effort and temperature capability maps — from
 * models.dev, so capability data is sourced, never hand-transcribed.
 *
 * Rules enforced here (each one turns a class of catalog mistakes
 * into a loud generation failure):
 *  - every offered BYOK model must be covered by upstream data or by
 *    an explicit dated override (`capabilities-overrides.ts`);
 *  - an override for a model the upstream source covers is rejected,
 *    so manual data can never shadow sourced data;
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
  REASONING_EFFORTS,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type { CapabilityOverride, ReasoningEffort } from "@stll/ai-catalog";

import { parseUpstreamCapabilities } from "./model-catalog-capabilities";
import type { UpstreamCapabilities } from "./model-catalog-capabilities";

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

export type CapabilityRow = {
  modelId: string;
  efforts: readonly ReasoningEffort[] | null;
  temperature: boolean;
  overrideReason: string | null;
};

export type BuildCapabilityRowsOptions = {
  /** `${modelsDevKey}:${modelId}` → upstream capability metadata. */
  upstream: ReadonlyMap<string, UpstreamCapabilities>;
};

/**
 * Resolve every offered BYOK model to a capability row, in catalog
 * declaration order. Throws with an actionable message on any gap or
 * conflict; a successful run proves full sourced coverage.
 */
export const buildCapabilityRows = ({
  upstream,
}: BuildCapabilityRowsOptions): CapabilityRow[] => {
  const rows: CapabilityRow[] = [];
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const mdKey = MODELS_DEV_KEY_BY_PROVIDER[provider];
    for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
      const record = upstream.get(`${mdKey}:${modelId}`);
      const override = OVERRIDE_BY_ID[modelId];
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
          modelId,
          efforts: override.reasoningEfforts,
          temperature: override.temperature,
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
      rows.push({
        modelId,
        efforts,
        temperature: record.temperature,
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

/** Render the generated module source. Deterministic for stable diffs. */
export const renderCapabilitiesModule = (rows: CapabilityRow[]): string => {
  const effortLines = rows.map((row) => {
    const comment =
      row.overrideReason === null
        ? ""
        : `  // override: ${row.overrideReason}\n`;
    return `${comment}  "${row.modelId}": ${renderEfforts(row.efforts)},`;
  });
  const temperatureLines = rows.map(
    (row) => `  "${row.modelId}": ${String(row.temperature)},`,
  );
  return `// AUTO-GENERATED by packages/scripts/src/model-catalog-capabilities-gen.ts.
// Do not edit by hand: regenerate with
// \`bun --filter @stll/ai-catalog gen:capabilities\`.
//
// Source: models.dev per-model \`reasoning_options\` and \`temperature\`
// (first-party, openrouter, and amazon-bedrock catalogs), plus dated
// entries from capabilities-overrides.ts for models the source does
// not cover. The nightly \`model-catalog-upstream\` check fails CI when
// upstream drifts from this file.
import type { OfferedBYOKModelId, ReasoningEffort } from "./index";

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
 * Whether each offered model accepts a \`temperature\` sampling
 * override; models declared \`false\` reject it with a 400. Consumers
 * must go through \`supportsTemperature\`.
 */
export const MODEL_TEMPERATURE_SUPPORT = {
${temperatureLines.join("\n")}
} as const satisfies Record<OfferedBYOKModelId, boolean>;
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

const main = async (): Promise<void> => {
  const checkOnly = Bun.argv.includes("--check");
  const upstream = await loadUpstream();
  const rows = buildCapabilityRows({ upstream });
  const rendered = renderCapabilitiesModule(rows);
  const existing = await Bun.file(OUTPUT_PATH)
    .text()
    .catch(() => null);
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
