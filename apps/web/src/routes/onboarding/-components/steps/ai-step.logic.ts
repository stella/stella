import type { ProviderRowStatus } from "@/components/ai-config-providers-editor";
import type {
  ProviderCredentialDraft,
  ProviderPreview,
  ProviderValue,
} from "@/components/ai-config-role-models.logic";

type FingerprintedRowStatus = Exclude<ProviderRowStatus, "idle" | "saved">;

export type RowState =
  | { status: "idle"; savedKey?: never }
  | {
      status: FingerprintedRowStatus;
      // Fingerprint of the key this validation attempt checked. Any edit
      // resets the row to "idle", which cannot retain a stale fingerprint.
      savedKey: string;
    };

export type RowStateMap = Record<ProviderValue, RowState>;

export const createProviderPreview = (
  providers: readonly ProviderCredentialDraft[],
  rowStates: RowStateMap,
): ProviderPreview[] => {
  const items: ProviderPreview[] = [];
  for (const draft of providers) {
    const state = rowStates[draft.provider];
    switch (state.status) {
      case "checking":
      case "invalid":
        items.push({ provider: draft.provider, status: state.status });
        break;
      case "valid":
        items.push({ provider: draft.provider, status: "valid" });
        break;
      case "idle":
        if (draft.apiKeyMasked !== undefined) {
          items.push({ provider: draft.provider, status: "valid" });
        }
        break;
      default: {
        const unreachable: never = state;
        return unreachable;
      }
    }
  }
  return items;
};
