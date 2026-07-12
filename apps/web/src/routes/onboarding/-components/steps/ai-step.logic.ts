import type { ProviderRowStatus } from "@/components/ai-config-providers-editor";
import type {
  ProviderCredentialDraft,
  ProviderPreview,
  ProviderValue,
} from "@/components/ai-config-role-models.logic";

export type RowState = {
  status: ProviderRowStatus;
  // Fingerprint of the key the user explicitly saved. The row
  // becomes "saved" only if the current key matches; any edit
  // resets the row to "idle".
  savedKey?: string;
};

export type RowStateMap = Record<ProviderValue, RowState>;

export const createProviderPreview = (
  providers: readonly ProviderCredentialDraft[],
  rowStates: RowStateMap,
): ProviderPreview[] => {
  const items: ProviderPreview[] = [];
  for (const draft of providers) {
    const state = rowStates[draft.provider];
    if (state.status === "checking" || state.status === "invalid") {
      items.push({ provider: draft.provider, status: state.status });
      continue;
    }
    if (state.status === "valid" || draft.apiKeyMasked !== undefined) {
      items.push({ provider: draft.provider, status: "valid" });
    }
  }
  return items;
};
