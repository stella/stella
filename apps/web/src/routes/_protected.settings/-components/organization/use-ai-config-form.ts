import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  getProviderValues,
  providerDraftsFromStoredProviders,
  roleOverridesFromStoredModels,
  serializeDecisionModel,
  serializeProviderDrafts,
  serializeRoleOverrides,
} from "@/components/ai-config-role-models.logic";
import type {
  ProviderCredentialDraft,
  RoleModelOverrides,
} from "@/components/ai-config-role-models.logic";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { api } from "@/lib/api";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { invalidateAIConfigurationCaches } from "@/lib/organization/ai-config-cache";
import {
  aiAvailabilityOptions,
  aiConfigKeys,
  updateCachedAIAvailability,
} from "@/lib/organization/ai-config-queries";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";

import { useAISettingsKeys } from "../../-hooks/use-ai-settings-keys";
import { useAISettingsToggles } from "../../-hooks/use-ai-settings-toggles";
import { useSettingsMutation } from "../../-hooks/use-settings-mutation";
import { canSaveAIConfig, hasAIConfigEdits } from "./ai-config-form.logic";
import { useAIConfigDrafts } from "./use-ai-config-drafts";

export type AIConfigReadState =
  | { status: "ready"; config: OrganizationAIConfig }
  | { status: "unreadable"; onRetry: () => void };

type UseAIConfigFormOptions = {
  readState: AIConfigReadState;
  organizationId: string;
};

type PersistAIConfigOptions = {
  nextProviders: ProviderCredentialDraft[];
  nextRoles: RoleModelOverrides;
};

/**
 * Sole owner of the AI settings page's edit, dirty and save model: the
 * provider/model/decision state and the auxiliary key and toggle sections all
 * save through `saveSettings`.
 */
export const useAIConfigForm = ({
  readState,
  organizationId,
}: UseAIConfigFormOptions) => {
  const config = readState.status === "ready" ? readState.config : null;
  const t = useTranslations("organization");
  const common = useTranslations("common");
  const queryClient = useQueryClient();
  const keySections = useAISettingsKeys();
  const toggleSections = useAISettingsToggles();
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const {
    recoveryAction,
    setRecoveryAction,
    storedProviders,
    setStoredProviders,
    providers,
    setProviders,
    roleModels,
    setRoleModels,
    savedRoles,
    setSavedRoles,
    decisionState,
    setDecisionState,
    storedDecision,
    setStoredDecision,
    feedback,
    setFeedback,
    ...handlers
  } = useAIConfigDrafts({ config, isReady: readState.status === "ready" });

  const hasAIEdits = hasAIConfigEdits({
    providers,
    storedProviders,
    roleModels,
    savedRoles,
    decisionState,
  });
  const isAIDirty =
    recoveryAction === "remove" || (readState.status === "ready" && hasAIEdits);
  const dirtyAuxiliarySections = [
    ...Object.values(keySections),
    ...Object.values(toggleSections),
  ].filter((section) => section.isDirty);
  const hasChangesToSave = isAIDirty || dirtyAuxiliarySections.length > 0;
  const blocker = useUnsavedWork({
    surface: "ai-provider-settings",
    guard: "confirm-navigation",
    isDirty:
      hasAIEdits ||
      recoveryAction === "remove" ||
      dirtyAuxiliarySections.length > 0,
  });
  const canSaveAI =
    recoveryAction === "remove" ||
    canSaveAIConfig({ providers, roleModels, decisionState, storedDecision });
  const canSaveSettings =
    (!isAIDirty || canSaveAI) &&
    dirtyAuxiliarySections.every((section) => section.canSave);

  const refresh = async (configured: boolean) => {
    if (config !== null) {
      queryClient.setQueryData(
        aiAvailabilityOptions({ organizationId }).queryKey,
        (current) =>
          updateCachedAIAvailability({
            current,
            instanceProvisioned: config.instanceProvisioned,
            orgConfigured: configured,
          }),
      );
    }
    await invalidateAIConfigurationCaches(queryClient, organizationId);
  };

  const persist = async ({
    nextProviders,
    nextRoles,
  }: PersistAIConfigOptions) => {
    const serialized = serializeRoleOverrides({
      providers: getProviderValues(nextProviders),
      overrides: nextRoles,
    });
    if (serialized.kind === "invalid") {
      return Result.err(
        new APIError({
          code: "ai_config_model_invalid",
          status: 400,
          message: t("aiConfig.selectModelForEachRole"),
        }),
      );
    }
    const decision = serializeDecisionModel(decisionState);
    const response = await api["organization-settings"]["ai-config"].post({
      providers: serializeProviderDrafts(nextProviders),
      overrideModels: serialized.overrides,
      ...(decision === undefined ? {} : { decision }),
    });
    const data = unwrapEden(response);
    const saved = providerDraftsFromStoredProviders(data.providers);
    setStoredProviders(saved);
    const savedOverrides = roleOverridesFromStoredModels({
      overrideModels: data.overrideModels,
      providers: getProviderValues(saved),
    });
    setRoleModels(savedOverrides);
    setSavedRoles(savedOverrides);
    setStoredDecision(data.decision);
    setDecisionState({ kind: "untouched" });
    await refresh(true);
    return Result.ok(saved);
  };

  const aiMutation = useSettingsMutation({
    invalidate: aiConfigKeys.all,
    mutationFn: async () => {
      if (providers.length === 0 || recoveryAction === "remove") {
        unwrapEden(await api["organization-settings"]["ai-config"].delete({}));
        setStoredProviders([]);
        setProviders([]);
        setRecoveryAction("keep");
        setRoleModels({});
        setSavedRoles({});
        setStoredDecision(null);
        setDecisionState({ kind: "untouched" });
        await refresh(false);
        return;
      }
      const saved = readQueryResult(
        await persist({
          nextProviders: providers,
          nextRoles: roleModels,
        }),
      );
      setProviders(saved);
    },
    onSuccess: () => setFeedback({ status: "saved" }),
  });
  const saveAI = async () => {
    setFeedback({ status: "saving" });
    const result = await Result.tryPromise({
      try: async () => await aiMutation.mutateAsync(),
      catch: (error: unknown) => error,
    });

    if (Result.isError(result)) {
      const error = result.error;
      setFeedback(
        APIError.is(error)
          ? {
              status: "error",
              message: error.rawMessage ?? error.message,
              code: error.code,
            }
          : { status: "error", message: common("somethingWentWrong") },
      );
    }
  };
  const saveSettings = async () => {
    setSaveState("saving");
    await Promise.all([
      ...(isAIDirty ? [saveAI()] : []),
      ...dirtyAuxiliarySections.map(async (section) => await section.save()),
    ]);
    setSaveState("idle");
  };

  return {
    config,
    keySections,
    toggleSections,
    blocker,
    saving: saveState === "saving",
    canClickSave: hasChangesToSave && canSaveSettings,
    saveSettings,
    feedback,
    providers,
    storedProviders,
    roleModels,
    decisionState,
    storedDecision,
    recoveryAction,
    ...handlers,
  };
};
