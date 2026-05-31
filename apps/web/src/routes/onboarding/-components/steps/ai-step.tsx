import { useCallback, useEffect, useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { AIConfigProvidersEditor } from "@/components/ai-config-providers-editor";
import type { ProviderRowStatus } from "@/components/ai-config-providers-editor";
import { AIConfigRoleModelPicker } from "@/components/ai-config-role-model-picker";
import {
  ensureRoleModelsForProviders,
  getProviderValues,
  PROVIDER_LABELS,
  serializeOverrideModels,
} from "@/components/ai-config-role-models.logic";
import type {
  ModelSelection,
  ProviderCredentialDraft,
  ProviderPreview,
  ProviderValue,
  RoleModelSelections,
  RoleValue,
} from "@/components/ai-config-role-models.logic";
import { api } from "@/lib/api";

export type AIStepPhase = "providers" | "models";

type AIStepProps = {
  providers: ProviderCredentialDraft[];
  roleModels: RoleModelSelections;
  phase: AIStepPhase;
  onProvidersChange: (providers: ProviderCredentialDraft[]) => void;
  onRoleModelsChange: (roleModels: RoleModelSelections) => void;
  onPhaseChange: (phase: AIStepPhase) => void;
  onPreviewChange?: (preview: readonly ProviderPreview[]) => void;
  onNext: () => void;
  onSkip: () => void;
};

const PROVIDER_KEY_PREVIEW_LEN = 8;

const fingerprintKey = (key: string) =>
  `${key.length}:${key.slice(-PROVIDER_KEY_PREVIEW_LEN)}`;

const fingerprintDraft = (draft: ProviderCredentialDraft): string | null => {
  const apiKey = draft.apiKey.trim();
  if (!apiKey) {
    return null;
  }
  const keyFingerprint = fingerprintKey(apiKey);
  if (draft.provider !== "azure_foundry" && draft.provider !== "huggingface") {
    return keyFingerprint;
  }
  return `${keyFingerprint}:${draft.endpoint.trim()}`;
};

type RowState = {
  status: ProviderRowStatus;
  // Fingerprint of the key the user explicitly saved. The row
  // becomes "saved" only if the current key matches; any edit
  // resets the row to "idle".
  savedKey?: string;
};

type RowStateMap = Record<ProviderValue, RowState>;

const INITIAL_ROW_STATES: RowStateMap = {
  google: { status: "idle" },
  anthropic: { status: "idle" },
  mistral: { status: "idle" },
  openai: { status: "idle" },
  azure_foundry: { status: "idle" },
  openrouter: { status: "idle" },
  huggingface: { status: "idle" },
};

export const AIStep = ({
  providers,
  roleModels,
  phase,
  onProvidersChange,
  onRoleModelsChange,
  onPreviewChange,
  onPhaseChange,
  onNext,
  onSkip,
}: AIStepProps) => {
  const t = useTranslations();
  const tOrganization = useTranslations("organization");

  const providerValues = getProviderValues(providers);
  const [rowStates, setRowStates] = useState<RowStateMap>(INITIAL_ROW_STATES);

  // Every provider in the list is either explicitly saved (valid)
  // or carries a previously-stored masked key.
  const allProvidersConfirmed = providers.every((draft) => {
    const fp = fingerprintDraft(draft);
    const state = rowStates[draft.provider];
    if (state.status === "valid" && state.savedKey && state.savedKey === fp) {
      return true;
    }
    if (!fp && draft.apiKeyMasked !== undefined) {
      return true;
    }
    return false;
  });
  const hasAnyConfirmed = providers.some((draft) => {
    const state = rowStates[draft.provider];
    return state.status === "valid" || draft.apiKeyMasked !== undefined;
  });
  const canEnterModelsPhase = hasAnyConfirmed && allProvidersConfirmed;
  const showModels = phase === "models";
  const canContinue =
    showModels &&
    canEnterModelsPhase &&
    serializeOverrideModels({ providers: providerValues, roleModels }) !== null;

  // Drop back to providers phase if a previously-confirmed key
  // was edited after entering the models phase.
  useEffect(() => {
    if (phase === "models" && !canEnterModelsPhase) {
      onPhaseChange("providers");
    }
  }, [canEnterModelsPhase, phase, onPhaseChange]);

  const toastedRef = useRef(new Set<string>());

  // Whenever a key changes against its saved fingerprint, reset
  // that row to idle so the user must save again.
  useEffect(() => {
    setRowStates((prev) => {
      let changed = false;
      const next: RowStateMap = { ...prev };
      for (const draft of providers) {
        const fp = fingerprintDraft(draft);
        const state = prev[draft.provider];
        // Edited away from the saved key — reset the row.
        if (
          state.savedKey &&
          fp !== null &&
          fp !== state.savedKey &&
          state.status !== "idle"
        ) {
          next[draft.provider] = { status: "idle" };
          changed = true;
        }
        // Cleared the input — reset.
        if (fp === null && state.status !== "idle" && !draft.apiKeyMasked) {
          next[draft.provider] = { status: "idle" };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [providers]);

  const saveRow = useCallback(
    async (index: number) => {
      const draft = providers[index];
      if (!draft) {
        return;
      }
      const apiKey = draft.apiKey.trim();
      if (!apiKey) {
        return;
      }
      const fp = fingerprintDraft(draft);
      if (!fp) {
        return;
      }
      setRowStates((prev) => ({
        ...prev,
        [draft.provider]: { status: "checking", savedKey: fp },
      }));

      const response = await api["ai-config"]["validate-provider"].post({
        provider: draft.provider,
        apiKey,
        ...(draft.provider === "azure_foundry"
          ? {
              endpoint: draft.endpoint.trim(),
              ...(draft.apiVersion ? { apiVersion: draft.apiVersion } : {}),
            }
          : {}),
        ...(draft.provider === "huggingface"
          ? { endpoint: draft.endpoint.trim() }
          : {}),
        ...(draft.provider === "google" ? { region: draft.region } : {}),
      });

      if (response.error) {
        // Provider unreachable (502) — treat as soft pass so the
        // user can proceed; otherwise show invalid.
        if (response.error.status === 502) {
          setRowStates((prev) => ({
            ...prev,
            [draft.provider]: { status: "valid", savedKey: fp },
          }));
          return;
        }
        setRowStates((prev) => ({
          ...prev,
          [draft.provider]: { status: "invalid", savedKey: fp },
        }));
        stellaToast.add({
          title: tOrganization("aiConfig.providerKeyInvalid", {
            provider: PROVIDER_LABELS[draft.provider],
          }),
          type: "warning",
        });
        return;
      }

      if (!response.data.valid) {
        setRowStates((prev) => ({
          ...prev,
          [draft.provider]: { status: "invalid", savedKey: fp },
        }));
        const toastKey = `${draft.provider}:${fp}`;
        if (!toastedRef.current.has(toastKey)) {
          toastedRef.current.add(toastKey);
          stellaToast.add({
            title: tOrganization("aiConfig.providerKeyInvalid", {
              provider: PROVIDER_LABELS[draft.provider],
            }),
            description: response.data.error,
            type: "warning",
          });
        }
        return;
      }

      setRowStates((prev) => ({
        ...prev,
        [draft.provider]: { status: "valid", savedKey: fp },
      }));
    },
    [providers, tOrganization],
  );

  // Push the preview list (provider + status) to the wizard so
  // the sidebar mock can render an accurate per-provider state.
  useEffect(() => {
    if (!onPreviewChange) {
      return;
    }
    const items: ProviderPreview[] = [];
    for (const draft of providers) {
      const state = rowStates[draft.provider];
      const hasConfirmed =
        state.status === "valid" || draft.apiKeyMasked !== undefined;
      if (state.status === "checking") {
        items.push({ provider: draft.provider, status: "checking" });
        continue;
      }
      if (state.status === "invalid") {
        items.push({ provider: draft.provider, status: "invalid" });
        continue;
      }
      if (hasConfirmed) {
        items.push({ provider: draft.provider, status: "valid" });
      }
    }
    onPreviewChange(items);
  }, [providers, rowStates, onPreviewChange]);

  const updateProviders = (next: ProviderCredentialDraft[]) => {
    onProvidersChange(next);
    onRoleModelsChange(
      ensureRoleModelsForProviders({
        providers: getProviderValues(next),
        roleModels,
      }),
    );
    // Drop validation entries for providers no longer in the draft list.
    const stillPresent = new Set(getProviderValues(next));
    setRowStates((prev) => ({
      google: stillPresent.has("google") ? prev.google : { status: "idle" },
      anthropic: stillPresent.has("anthropic")
        ? prev.anthropic
        : { status: "idle" },
      mistral: stillPresent.has("mistral") ? prev.mistral : { status: "idle" },
      openai: stillPresent.has("openai") ? prev.openai : { status: "idle" },
      azure_foundry: stillPresent.has("azure_foundry")
        ? prev.azure_foundry
        : { status: "idle" },
      openrouter: stillPresent.has("openrouter")
        ? prev.openrouter
        : { status: "idle" },
      huggingface: stillPresent.has("huggingface")
        ? prev.huggingface
        : { status: "idle" },
    }));
  };

  const setRoleModel = (role: RoleValue, model: ModelSelection | null) => {
    onRoleModelsChange({
      ...roleModels,
      [role]: model,
    });
  };

  const rowStatusList: ProviderRowStatus[] = providers.map(
    (draft) => rowStates[draft.provider].status,
  );

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.aiTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.aiSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {phase === "providers" ? (
          <AIConfigProvidersEditor
            compact
            onProvidersChange={updateProviders}
            onSaveRow={(index) => {
              // eslint-disable-next-line typescript/no-floating-promises
              saveRow(index);
            }}
            providers={providers}
            rowStatuses={rowStatusList}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-foreground text-sm font-semibold">
                  {tOrganization("aiConfig.chooseModelsTitle")}
                </h2>
                <p className="text-muted-foreground text-xs">
                  {tOrganization("aiConfig.chooseModelsSubtitle")}
                </p>
              </div>
              <Button
                onClick={() => onPhaseChange("providers")}
                size="sm"
                type="button"
                variant="ghost"
              >
                {tOrganization("aiConfig.editProviders")}
              </Button>
            </div>
            <AIConfigRoleModelPicker
              compact
              onModelChange={setRoleModel}
              providers={providerValues}
              roleModels={roleModels}
            />
          </div>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-6">
        <Button onClick={onSkip} type="button" variant="ghost">
          {t("onboarding.skipStep")}
        </Button>
        {phase === "providers" ? (
          <Button
            disabled={!canEnterModelsPhase}
            onClick={() => onPhaseChange("models")}
            type="button"
          >
            {t("common.next")}
          </Button>
        ) : (
          <Button disabled={!canContinue} onClick={onNext} type="button">
            {t("common.next")}
          </Button>
        )}
      </div>
    </>
  );
};
