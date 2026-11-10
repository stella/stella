import { Panic, panic } from "better-result";

import { BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";
import type { BYOKProvider, ModelOverrideGroup } from "@stll/ai-catalog";

import { env } from "@/api/env";
import type { OrgAIConfig, OrgAIModelSelection } from "@/api/lib/ai-config";

// The workflow and playbook paths dispatch through the "pdf" model role, so
// the only way to steer them at a given model is an `OrgAIConfig` BYOK
// override — the same mechanism org AI settings use. Every role is pointed
// at the same selection.
const PROVIDER_ENV_CREDENTIALS: Record<BYOKProvider, string | undefined> = {
  google: env.GOOGLE_GENERATIVE_AI_API_KEY,
  openrouter: env.OPENROUTER_API_KEY,
  openai: env.OPENAI_API_KEY,
  anthropic: env.ANTHROPIC_API_KEY,
  bedrock: env.BEDROCK_API_KEY,
  mistral: env.MISTRAL_API_KEY,
};

const isByokProvider = (value: string): value is BYOKProvider =>
  value in BYOK_MODEL_OPTIONS;

// Derived from the catalog's own keys (not hand-listed) so a new BYOKProvider
// is picked up here automatically instead of silently missing from bare-model
// resolution.
const BYOK_PROVIDERS = Object.keys(BYOK_MODEL_OPTIONS).filter(isByokProvider);

type ModelSelection = {
  provider: BYOKProvider;
  modelId: string;
  apiKey: string;
};

const resolveExplicitModelSelection = (
  spec: string,
  providerRaw: string,
  modelId: string,
): ModelSelection => {
  if (!isByokProvider(providerRaw)) {
    return panic(`Unknown AI provider "${providerRaw}" in model id "${spec}"`);
  }
  const apiKey = PROVIDER_ENV_CREDENTIALS[providerRaw];
  if (apiKey === undefined) {
    return panic(
      `No credentials configured for provider "${providerRaw}" (model "${spec}")`,
    );
  }
  return { provider: providerRaw, modelId, apiKey };
};

// A bare id (no "provider::" prefix): find a directly-offered provider with
// credentials, else route the same id through OpenRouter's
// "<provider>/<modelId>" form when OpenRouter is credentialed.
const resolveBareModelSelection = (modelId: string): ModelSelection => {
  const directProviders = BYOK_PROVIDERS.filter((provider) => {
    const offered: readonly string[] = BYOK_MODEL_OPTIONS[provider];
    return provider !== "openrouter" && offered.includes(modelId);
  });

  const credentialedProvider = directProviders.find(
    (provider) => PROVIDER_ENV_CREDENTIALS[provider] !== undefined,
  );
  if (credentialedProvider !== undefined) {
    const apiKey = PROVIDER_ENV_CREDENTIALS[credentialedProvider];
    if (apiKey === undefined) {
      return panic(`Missing credential resolved for "${credentialedProvider}"`);
    }
    return { provider: credentialedProvider, modelId, apiKey };
  }

  const openRouterApiKey = PROVIDER_ENV_CREDENTIALS.openrouter;
  const openRouterOptions: readonly string[] = BYOK_MODEL_OPTIONS.openrouter;

  // An id OpenRouter already serves natively (e.g. "openai/gpt-5.6-luna")
  // resolves directly, before falling back to "<provider>/<modelId>" routing
  // for a provider-native id OpenRouter mirrors under a provider prefix.
  if (openRouterApiKey !== undefined && openRouterOptions.includes(modelId)) {
    return { provider: "openrouter", modelId, apiKey: openRouterApiKey };
  }

  const routedProvider = directProviders.find((provider) =>
    openRouterOptions.includes(`${provider}/${modelId}`),
  );
  if (openRouterApiKey !== undefined && routedProvider !== undefined) {
    return {
      provider: "openrouter",
      modelId: `${routedProvider}/${modelId}`,
      apiKey: openRouterApiKey,
    };
  }

  return panic(
    `No credentialed provider offers model "${modelId}" directly or via OpenRouter`,
  );
};

const resolveModelSelection = (spec: string): ModelSelection => {
  const separatorIndex = spec.indexOf("::");
  if (separatorIndex === -1) {
    return resolveBareModelSelection(spec);
  }
  return resolveExplicitModelSelection(
    spec,
    spec.slice(0, separatorIndex),
    spec.slice(separatorIndex + 2),
  );
};

const buildOrgAIConfig = (selection: ModelSelection): OrgAIConfig => {
  const modelSelection: OrgAIModelSelection = {
    provider: selection.provider,
    modelId: selection.modelId,
  };
  const overrideModels: Record<ModelOverrideGroup, OrgAIModelSelection> = {
    fast: modelSelection,
    chat: modelSelection,
    reasoning: modelSelection,
    pdf: modelSelection,
    browse: modelSelection,
  };
  return {
    providers: [{ provider: selection.provider, apiKey: selection.apiKey }],
    overrideModels,
    decision: null,
  };
};

// A model spec resolves independently of its siblings: one invalid provider
// or missing credential must not stop the other `--models` entries from
// running. `resolveModelSelection` panics on failure (a defect, not a typed
// Result) because it also guards genuine programmer errors elsewhere; here
// that panic is an expected per-spec outcome, so it is caught at this
// boundary and turned into the documented "error" score for every task and
// repeat of that model.
export type ModelTarget =
  | { type: "resolved"; id: string; orgAIConfig: OrgAIConfig }
  | { type: "resolution-error"; id: string; message: string };

export const resolveModelTargets = (specs: readonly string[]): ModelTarget[] =>
  specs.map((spec) => {
    try {
      return {
        type: "resolved",
        id: spec,
        orgAIConfig: buildOrgAIConfig(resolveModelSelection(spec)),
      };
    } catch (error) {
      if (!Panic.is(error)) {
        throw error;
      }
      return { type: "resolution-error", id: spec, message: error.message };
    }
  });
