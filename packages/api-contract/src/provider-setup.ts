import * as v from "valibot";

export const PROVIDER_SETUP_ERROR_CODE = {
  anthropicWorkspaceRequired: "ai_config_anthropic_workspace_required",
  anthropicSubscriptionToken: "ai_config_anthropic_subscription_token",
  anthropicNoCredits: "ai_config_anthropic_no_credits",
  anthropicKeyDisabled: "ai_config_anthropic_key_disabled",
  anthropicOrganizationRestricted:
    "ai_config_anthropic_organization_restricted",
  openaiProjectOrganizationMismatch:
    "ai_config_openai_project_organization_mismatch",
  openaiInsufficientQuota: "ai_config_openai_insufficient_quota",
  googleApiNotEnabled: "ai_config_google_api_not_enabled",
  googleKeyRestricted: "ai_config_google_key_restricted",
  openrouterNoCredits: "ai_config_openrouter_no_credits",
  azureModelNotEnabled: "ai_config_azure_model_not_enabled",
  bedrockModelNotEnabled: "ai_config_bedrock_model_not_enabled",
} as const;

export type ProviderSetupErrorCode =
  (typeof PROVIDER_SETUP_ERROR_CODE)[keyof typeof PROVIDER_SETUP_ERROR_CODE];

export const PROVIDER_SETUP_ERROR_CATALOGUE = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    provider: "anthropic",
    field: "anthropicWorkspaceId",
    url: "https://console.anthropic.com/settings/workspaces",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken]: {
    provider: "anthropic",
    field: "apiKey",
    url: "https://console.anthropic.com/settings/keys",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits]: {
    provider: "anthropic",
    field: "apiKey",
    url: "https://console.anthropic.com/settings/billing",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicKeyDisabled]: {
    provider: "anthropic",
    field: "apiKey",
    url: "https://console.anthropic.com/settings/keys",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicOrganizationRestricted]: {
    provider: "anthropic",
    field: "apiKey",
    url: "https://console.anthropic.com/settings/organization",
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiProjectOrganizationMismatch]: {
    provider: "openai",
    field: "apiKey",
    url: "https://platform.openai.com/settings/organization/projects",
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota]: {
    provider: "openai",
    field: "apiKey",
    url: "https://platform.openai.com/settings/organization/billing/overview",
  },
  [PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled]: {
    provider: "google",
    field: "apiKey",
    url: "https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com",
  },
  [PROVIDER_SETUP_ERROR_CODE.googleKeyRestricted]: {
    provider: "google",
    field: "apiKey",
    url: "https://console.cloud.google.com/apis/credentials",
  },
  [PROVIDER_SETUP_ERROR_CODE.openrouterNoCredits]: {
    provider: "openrouter",
    field: "apiKey",
    url: "https://openrouter.ai/settings/credits",
  },
  [PROVIDER_SETUP_ERROR_CODE.azureModelNotEnabled]: {
    provider: "azure_foundry",
    field: "endpoint",
    url: "https://ai.azure.com/",
  },
  [PROVIDER_SETUP_ERROR_CODE.bedrockModelNotEnabled]: {
    provider: "bedrock",
    field: "region",
    url: "https://console.aws.amazon.com/bedrock/home#/modelaccess",
  },
} as const satisfies Record<
  ProviderSetupErrorCode,
  { provider: string; field: string; url: string }
>;

export const providerDiagnosticSchema = v.strictObject({
  provider: v.string(),
  code: v.nullable(v.picklist(Object.values(PROVIDER_SETUP_ERROR_CODE))),
  message: v.string(),
});
export type ProviderDiagnostic = v.InferOutput<typeof providerDiagnosticSchema>;
