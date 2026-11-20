import { panic } from "better-result";

import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";

import {
  getProviderValues,
  hasProviderCredentialChanges,
  hasUsableDecisionModel,
  hasUsableOpenAIKey,
  hasUsableProviderDrafts,
  haveSameRoleModelSelections,
  providerDraftsFromStoredProviders,
  ROLE_KEYS,
  roleOverridesFromStoredModels,
  serializeRoleOverrides,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  ProviderCredentialDraft,
  ProviderValue,
  RoleModelOverrides,
  RoleModelSelections,
  RoleValue,
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
  // No rows until the admin adds one: a pre-added blank row reads as a
  // provider the organization chose and still has to fill.
  if (config?.configured !== true) {
    return {
      storedProviders: [],
      providers: [],
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
    hasUsableDecisionModel({
      state: decisionState,
      stored: storedDecision,
      hasOpenAIKey: hasUsableOpenAIKey(providers),
    }));

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

/**
 * What the organization's own provider keys mean for it: AI already runs on
 * the models stella provides (`builtIn`), needs a key first (`keyRequired`),
 * or runs on the saved keys (`ownKeys`). `unknown` while availability is
 * unread or cannot tell (a member without an AI seat, an unreadable config).
 */
export type ProviderKeyNeed = "builtIn" | "keyRequired" | "ownKeys" | "unknown";

type ProviderKeyNeedOptions = {
  configured: boolean;
  availability: OrganizationAIAvailability | undefined;
};

export const resolveProviderKeyNeed = ({
  configured,
  availability,
}: ProviderKeyNeedOptions): ProviderKeyNeed => {
  if (configured) {
    return "ownKeys";
  }
  if (availability === undefined) {
    return "unknown";
  }
  if (availability.available) {
    return "builtIn";
  }
  switch (availability.unavailableReason) {
    case "own_key_required":
    case "provider_not_configured":
      return "keyRequired";
    case "member_assignment_required":
    case "unreadable":
    case null:
      return "unknown";
    default:
      availability.unavailableReason satisfies never;
      return panic("Unhandled AI unavailable reason");
  }
};

/** The modes (chat, fast, reasoning, PDF) each provider serves, in mode order. */
export const modesByProvider = (
  selections: RoleModelSelections,
): ReadonlyMap<ProviderValue, readonly RoleValue[]> => {
  const modes = new Map<ProviderValue, RoleValue[]>();
  for (const role of ROLE_KEYS) {
    const provider = selections[role]?.provider;
    if (provider !== undefined) {
      modes.set(provider, [...(modes.get(provider) ?? []), role]);
    }
  }
  return modes;
};

/** Whether two provider lists name the same providers, in any order. */
export const sameProviderSet = (
  left: readonly ProviderCredentialDraft[],
  right: readonly ProviderCredentialDraft[],
) =>
  left.length === right.length &&
  left.every((draft) =>
    right.some((other) => other.provider === draft.provider),
  );
