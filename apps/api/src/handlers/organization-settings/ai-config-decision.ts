import { panic } from "better-result";

import type {
  DecisionModelProvider,
  OrgAIProviderConfig,
  OrgDecisionModelConfig,
} from "@/api/lib/ai-config";

type DecisionConfigInput = {
  provider: DecisionModelProvider;
  apiKey?: string | null | undefined;
  region?: "eu" | "global" | undefined;
  modelId: string;
};

type ProbeConfig = OrgDecisionModelConfig & { apiKey: string };
export type DecisionConfigResult =
  | { valid: true; decision: OrgDecisionModelConfig | null; needsProbe: false }
  | {
      valid: true;
      decision: OrgDecisionModelConfig;
      needsProbe: true;
      probeConfig: ProbeConfig;
    }
  | { valid: false; error: string };

type ResolveDecisionConfigOptions = {
  input: DecisionConfigInput | null | undefined;
  existing: OrgDecisionModelConfig | null | undefined;
  providers: readonly OrgAIProviderConfig[];
  existingProviders: readonly OrgAIProviderConfig[];
};

export const resolveDecisionConfig = ({
  input,
  existing,
  providers,
  existingProviders,
}: ResolveDecisionConfigOptions): DecisionConfigResult => {
  if (input === null || (input === undefined && !existing)) {
    return { valid: true, decision: null, needsProbe: false };
  }
  const selection = input ?? existing;
  if (!selection) {
    return { valid: true, decision: null, needsProbe: false };
  }
  const modelId = selection.modelId.trim();
  if (!modelId) {
    return {
      valid: false,
      error: "A model is required for the decision model",
    };
  }
  const storedKey =
    existing?.provider === selection.provider ? existing.apiKey : undefined;
  const apiKey =
    input?.apiKey === null ? undefined : selection.apiKey?.trim() || storedKey;
  let decision: OrgDecisionModelConfig;
  switch (selection.provider) {
    case "typesafe":
      if (!apiKey) {
        return {
          valid: false,
          error: "API key is required for the decision model",
        };
      }
      decision = { provider: "typesafe", apiKey, modelId };
      break;
    case "openai":
      decision = {
        provider: "openai",
        ...(apiKey ? { apiKey } : {}),
        region:
          input?.region ??
          (existing?.provider === "openai" ? existing.region : "eu"),
        modelId,
      };
      break;
    default:
      selection satisfies never;
      return panic("Unhandled decision provider");
  }
  return resolveDecisionProbe({
    decision,
    inputApiKey: input?.apiKey,
    existing,
    providers,
    existingProviders,
  });
};

type ResolveDecisionProbeOptions = {
  decision: OrgDecisionModelConfig;
  inputApiKey: string | null | undefined;
  existing: OrgDecisionModelConfig | null | undefined;
  providers: readonly OrgAIProviderConfig[];
  existingProviders: readonly OrgAIProviderConfig[];
};

const resolveDecisionProbe = ({
  decision,
  inputApiKey,
  existing,
  providers,
  existingProviders,
}: ResolveDecisionProbeOptions): DecisionConfigResult => {
  const resolvedKey =
    decision.apiKey ??
    providers.find(({ provider }) => provider === "openai")?.apiKey;
  if (!resolvedKey) {
    return {
      valid: false,
      error:
        "The decision model reuses your OpenAI API key. Keep that provider and key, add a separate decision API key, or switch the decision provider.",
    };
  }
  const previousKey =
    existing?.apiKey ??
    (existing?.provider === "openai"
      ? existingProviders.find(({ provider }) => provider === "openai")?.apiKey
      : undefined);
  const existingChanged = !existing
    ? true
    : existing.provider !== decision.provider ||
      existing.modelId !== decision.modelId ||
      (decision.provider === "openai" &&
        (existing.provider !== "openai" ||
          existing.region !== decision.region));
  const needsProbe =
    (inputApiKey !== null &&
      inputApiKey !== undefined &&
      !!inputApiKey.trim()) ||
    existingChanged ||
    previousKey !== resolvedKey;
  if (!needsProbe) {
    return { valid: true, decision, needsProbe: false };
  }
  return {
    valid: true,
    decision,
    needsProbe: true,
    probeConfig:
      decision.provider === "openai"
        ? {
            provider: "openai",
            modelId: decision.modelId,
            region: decision.region,
            apiKey: resolvedKey,
          }
        : {
            provider: "typesafe",
            modelId: decision.modelId,
            apiKey: resolvedKey,
          },
  };
};
