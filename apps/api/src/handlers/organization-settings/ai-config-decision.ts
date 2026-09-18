/**
 * Resolving the decision model an AI-config update stores.
 *
 * The decision model is not one of the generative roles, so it merges on its
 * own terms: an absent field keeps what is stored, `null` clears it, and an
 * object replaces it. A key may be omitted only to keep the stored one, and
 * only while the provider stays the same, so a provider switch can never
 * inherit a credential that was issued for another one.
 */

import type {
  DecisionModelProvider,
  OrgDecisionModelConfig,
} from "@/api/lib/ai-config";

export type DecisionConfigInput = {
  provider: DecisionModelProvider;
  apiKey?: string | undefined;
  modelId: string;
};

export type DecisionConfigResult =
  | {
      valid: true;
      decision: OrgDecisionModelConfig | null;
      /** The key came in with this request, so it still has to be probed. */
      keyIsNew: boolean;
    }
  | { valid: false; error: string };

export const resolveDecisionConfig = (
  input: DecisionConfigInput | null | undefined,
  existing: OrgDecisionModelConfig | null | undefined,
): DecisionConfigResult => {
  if (input === undefined) {
    return { valid: true, decision: existing ?? null, keyIsNew: false };
  }
  if (input === null) {
    return { valid: true, decision: null, keyIsNew: false };
  }

  const modelId = input.modelId.trim();
  if (!modelId) {
    return {
      valid: false,
      error: "A model is required for the decision model",
    };
  }

  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    return {
      valid: true,
      decision: { provider: input.provider, apiKey, modelId },
      keyIsNew: true,
    };
  }

  // The stored key is filed under its own provider and read back by lookup,
  // not by comparison, so a second provider cannot inherit a credential that
  // was issued for the first one.
  const storedKeys: Partial<Record<DecisionModelProvider, string>> = existing
    ? { [existing.provider]: existing.apiKey }
    : {};
  const reusableKey = storedKeys[input.provider];
  if (reusableKey === undefined) {
    return {
      valid: false,
      error: "API key is required for the decision model",
    };
  }

  return {
    valid: true,
    decision: { provider: input.provider, apiKey: reusableKey, modelId },
    keyIsNew: false,
  };
};
