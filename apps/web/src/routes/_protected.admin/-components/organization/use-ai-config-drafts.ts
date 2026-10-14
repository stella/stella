import { useState } from "react";

import {
  getProviderValues,
  retainRoleOverridesForProviders,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  ModelSelection,
  ProviderCredentialDraft,
  RoleValue,
} from "@/components/ai-config-role-models.logic";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";

import { deriveInitialAIConfig } from "./ai-config-form.logic";
import type { AIConfigFeedback } from "./ai-config-form.logic";

type UseAIConfigDraftsOptions = {
  config: OrganizationAIConfig | null;
  isReady: boolean;
};

/** Draft state and edit handlers; saving and dirtiness live in `useAIConfigForm`. */
export const useAIConfigDrafts = ({
  config,
  isReady,
}: UseAIConfigDraftsOptions) => {
  const initial = deriveInitialAIConfig(config);
  const [initialization, setInitialization] = useState<
    "awaiting-config" | "initialized"
  >(config === null ? "awaiting-config" : "initialized");
  const [recoveryAction, setRecoveryAction] = useState<"keep" | "remove">(
    "keep",
  );
  const [storedProviders, setStoredProviders] = useState(
    initial.storedProviders,
  );
  const [providers, setProviders] = useState(initial.providers);
  const [roleModels, setRoleModels] = useState(initial.roles);
  const [savedRoles, setSavedRoles] = useState(initial.roles);
  const [decisionState, setDecisionState] = useState<DecisionModelState>({
    kind: "untouched",
  });
  const [storedDecision, setStoredDecision] = useState(initial.decision);
  const [feedback, setFeedback] = useState<AIConfigFeedback>({
    status: "idle",
  });

  if (initialization === "awaiting-config" && config !== null) {
    setInitialization("initialized");
    setStoredProviders(initial.storedProviders);
    setProviders(initial.providers);
    setRoleModels(initial.roles);
    setSavedRoles(initial.roles);
    setStoredDecision(initial.decision);
    setDecisionState({ kind: "untouched" });
    if (feedback.status !== "saved") {
      setFeedback({ status: "idle" });
    }
  }
  if (isReady && recoveryAction === "remove") {
    setRecoveryAction("keep");
    setFeedback({ status: "idle" });
  }

  const clearFeedback = () => setFeedback({ status: "idle" });
  const changeProviders = (next: ProviderCredentialDraft[]) => {
    setProviders(next);
    clearFeedback();
  };
  const removeProvider = (draft: ProviderCredentialDraft) => {
    const next = providers.filter(
      (provider) => provider.provider !== draft.provider,
    );
    setProviders(next);
    setRoleModels((current) =>
      retainRoleOverridesForProviders({
        providers: getProviderValues(next),
        overrides: current,
      }),
    );
    clearFeedback();
  };
  const changeRole = (role: RoleValue, model: ModelSelection | null) => {
    setRoleModels((previous) => ({ ...previous, [role]: model }));
    clearFeedback();
  };
  const resetRole = (role: RoleValue) => {
    setRoleModels((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([key]) => key !== role),
      ),
    );
    clearFeedback();
  };
  const changeDecision = (next: DecisionModelState) => {
    setDecisionState(next);
    clearFeedback();
  };
  const toggleRecovery = () => {
    setRecoveryAction(recoveryAction === "keep" ? "remove" : "keep");
    clearFeedback();
  };

  return {
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
    changeProviders,
    removeProvider,
    changeRole,
    resetRole,
    changeDecision,
    toggleRecovery,
  };
};
