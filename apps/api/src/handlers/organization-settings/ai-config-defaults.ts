import type { AIProvider } from "@stll/ai-catalog";
import { resolveDefaultOverrideModels } from "@stll/ai-catalog/model-defaults-ledger";

export const resolveAIConfigDefaults = <TProvider extends AIProvider>(
  providers: readonly TProvider[],
) => ({
  defaultModels: resolveDefaultOverrideModels(providers),
  providerDefaultModels: providers.map((provider) => ({
    provider,
    defaultModels: resolveDefaultOverrideModels([provider]),
  })),
});
