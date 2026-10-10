export const PROVIDER_SETUP_ERROR_CODE = {
  anthropicWorkspaceRequired: "ai_config_anthropic_workspace_required",
} as const;

export type ProviderSetupErrorCode =
  (typeof PROVIDER_SETUP_ERROR_CODE)[keyof typeof PROVIDER_SETUP_ERROR_CODE];

export const PROVIDER_SETUP_ERROR_CATALOGUE = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    provider: "anthropic",
    field: "anthropicWorkspaceId",
    url: "https://console.anthropic.com/settings/workspaces",
  },
} as const satisfies Record<
  ProviderSetupErrorCode,
  { provider: string; field: string; url: string }
>;
