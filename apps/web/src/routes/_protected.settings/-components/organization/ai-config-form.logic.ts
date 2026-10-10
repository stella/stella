import {
  createProviderCredentialDraft,
  getProviderValues,
  haveSameRoleModelSelections,
  hasProviderCredentialChanges,
  hasUsableDecisionModel,
  hasUsableProviderDrafts,
  providerDraftsFromStoredProviders,
  roleOverridesFromStoredModels,
  serializeRoleOverrides,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  ProviderCredentialDraft,
  RoleModelOverrides,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";

import type { SectionFeedback } from "./ai-settings-section";

export type AIConfigFeedback =
  | Exclude<SectionFeedback, { status: "error" }>
  | { status: "error"; message: string; code?: string | undefined };

type InitialAIConfig = {
  storedProviders: ProviderCredentialDraft[];
  providers: ProviderCredentialDraft[];
  roles: RoleModelOverrides;
  decision: StoredDecisionModel | null;
};

export const deriveInitialAIConfig = (
  config: OrganizationAIConfig | null,
): InitialAIConfig => {
  if (config?.configured !== true) {
    return {
      storedProviders: [],
      providers: [createProviderCredentialDraft()],
      roles: {},
      decision: null,
    };
  }
  const stored = providerDraftsFromStoredProviders(config.providers);
  return {
    storedProviders: stored,
    providers: stored,
    roles: roleOverridesFromStoredModels({
      overrideModels: config.overrideModels,
      providers: getProviderValues(stored),
    }),
    decision: config.decision,
  };
};

type AIEditsOptions = {
  providers: ProviderCredentialDraft[];
  storedProviders: ProviderCredentialDraft[];
  roleModels: RoleModelOverrides;
  savedRoles: RoleModelOverrides;
  decisionState: DecisionModelState;
};

export const hasAIConfigEdits = ({
  providers,
  storedProviders,
  roleModels,
  savedRoles,
  decisionState,
}: AIEditsOptions) => {
  const removedProvider = storedProviders.some(
    (stored) => !providers.some((draft) => draft.provider === stored.provider),
  );
  const changedProvider = providers.some((draft) =>
    hasProviderCredentialChanges({
      draft,
      stored: storedProviders.find(
        (saved) => saved.provider === draft.provider,
      ),
    }),
  );
  return (
    removedProvider ||
    changedProvider ||
    decisionState.kind !== "untouched" ||
    !haveSameRoleModelSelections({ current: roleModels, baseline: savedRoles })
  );
};

type CanSaveAIOptions = {
  providers: ProviderCredentialDraft[];
  roleModels: RoleModelOverrides;
  decisionState: DecisionModelState;
  storedDecision: StoredDecisionModel | null;
};

export const canSaveAIConfig = ({
  providers,
  roleModels,
  decisionState,
  storedDecision,
}: CanSaveAIOptions) =>
  providers.length === 0 ||
  (hasUsableProviderDrafts(providers) &&
    serializeRoleOverrides({
      providers: getProviderValues(providers),
      overrides: roleModels,
    }).kind === "valid" &&
    hasUsableDecisionModel({ state: decisionState, stored: storedDecision }));

type HasCustomOptions = {
  roleModels: RoleModelOverrides;
  decisionState: DecisionModelState;
  storedDecision: StoredDecisionModel | null;
};

export const hasCustomAIModels = ({
  roleModels,
  decisionState,
  storedDecision,
}: HasCustomOptions) => {
  if (Object.keys(roleModels).length > 0) {
    return true;
  }
  return decisionState.kind === "untouched"
    ? storedDecision !== null
    : decisionState.kind === "set";
};
