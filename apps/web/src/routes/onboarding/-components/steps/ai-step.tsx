import { useLayoutEffect, useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Form } from "@stll/ui/components/form";
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
  return keyFingerprint;
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
  openai: { status: "idle" },
  openrouter: { status: "idle" },
  mistral: { status: "idle" },
  bedrock: { status: "idle" },
};

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
  const rowStatesRef = useRef(rowStates);
  const commitRowStates = (next: RowStateMap) => {
    rowStatesRef.current = next;
    setRowStates(next);
  };
  useLayoutEffect(() => {
    onPreviewChange?.(createProviderPreview(providers, rowStates));
  }, [onPreviewChange, providers, rowStates]);

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

  const toastedRef = useRef(new Set<string>());

  // Whenever a key changes against its saved fingerprint, reset
  // that row to idle so the user must save again.
  const saveRow = async (index: number) => {
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
    commitRowStates({
      ...rowStatesRef.current,
      [draft.provider]: { status: "checking", savedKey: fp },
    });

    const response = await api["ai-config"]["validate-provider"].post({
      provider: draft.provider,
      apiKey,
      ...(draft.provider === "google" ? { region: draft.region } : {}),
    });

    if (response.error) {
      // Provider unreachable (502) — treat as soft pass so the
      // user can proceed; otherwise show invalid.
      if (response.error.status === 502) {
        commitRowStates({
          ...rowStatesRef.current,
          [draft.provider]: { status: "valid", savedKey: fp },
        });
        return;
      }
      commitRowStates({
        ...rowStatesRef.current,
        [draft.provider]: { status: "invalid", savedKey: fp },
      });
      stellaToast.add({
        title: tOrganization("aiConfig.providerKeyInvalid", {
          provider: PROVIDER_LABELS[draft.provider],
        }),
        type: "warning",
      });
      return;
    }

    if (!response.data.valid) {
      commitRowStates({
        ...rowStatesRef.current,
        [draft.provider]: { status: "invalid", savedKey: fp },
      });
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

    commitRowStates({
      ...rowStatesRef.current,
      [draft.provider]: { status: "valid", savedKey: fp },
    });
  };

  const updateProviders = (next: ProviderCredentialDraft[]) => {
    if (phase === "models") {
      onPhaseChange("providers");
    }
    onProvidersChange(next);
    onRoleModelsChange(
      ensureRoleModelsForProviders({
        providers: getProviderValues(next),
        roleModels,
      }),
    );
    // Drop validation entries for providers no longer in the draft list.
    const stillPresent = new Set(getProviderValues(next));
    const current = rowStatesRef.current;
    const nextRowStates: RowStateMap = {
      google: stillPresent.has("google") ? current.google : { status: "idle" },
      anthropic: stillPresent.has("anthropic")
        ? current.anthropic
        : { status: "idle" },
      openai: stillPresent.has("openai") ? current.openai : { status: "idle" },
      openrouter: stillPresent.has("openrouter")
        ? current.openrouter
        : { status: "idle" },
      mistral: stillPresent.has("mistral")
        ? current.mistral
        : { status: "idle" },
      bedrock: stillPresent.has("bedrock")
        ? current.bedrock
        : { status: "idle" },
    };
    for (const draft of next) {
      const fingerprint = fingerprintDraft(draft);
      const state = nextRowStates[draft.provider];
      const changedSavedKey =
        state.savedKey !== undefined &&
        fingerprint !== null &&
        fingerprint !== state.savedKey &&
        state.status !== "idle";
      const clearedKey =
        fingerprint === null && state.status !== "idle" && !draft.apiKeyMasked;
      if (changedSavedKey || clearedKey) {
        nextRowStates[draft.provider] = { status: "idle" };
      }
    }
    commitRowStates(nextRowStates);
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

      {/* display:contents keeps the existing flex layout; the form only
          exists so Enter advances the active phase when it is valid.
          The provider editor's own buttons are type="button", so a
          key/save keypress never triggers this submit. */}
      <Form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (phase === "providers") {
            if (canEnterModelsPhase) {
              onPhaseChange("models");
            }
            return;
          }
          if (canContinue) {
            onNext();
          }
        }}
      >
        <div className="mt-8 flex flex-col gap-3">
          {phase === "providers" ? (
            <AIConfigProvidersEditor
              compact
              onProvidersChange={updateProviders}
              onSaveRow={(index) => {
                void saveRow(index);
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
            <Button disabled={!canEnterModelsPhase} type="submit">
              {t("common.next")}
            </Button>
          ) : (
            <Button disabled={!canContinue} type="submit">
              {t("common.next")}
            </Button>
          )}
        </div>
      </Form>
    </>
  );
};
