import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import type { identifyProviderSetupError } from "@/api/lib/provider-error-catalogue";

/** Static provider response shapes derived from the providers' error references. */
export const PROVIDER_SETUP_ERROR_FIXTURES = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    provider: "anthropic",
    error: {
      type: "invalid_request_error",
      message:
        "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken]: {
    provider: "anthropic",
    error: {
      type: "authentication_error",
      message: "OAuth authentication is currently not supported.",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits]: {
    provider: "anthropic",
    error: { type: "billing_error", message: "Credit balance too low" },
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicKeyDisabled]: {
    provider: "anthropic",
    error: {
      type: "authentication_error",
      message: "API key has been deactivated.",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicOrganizationRestricted]: {
    provider: "anthropic",
    error: {
      type: "permission_error",
      message: "Organization access restricted",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiProjectOrganizationMismatch]: {
    provider: "openai",
    error: {
      type: "invalid_request_error",
      code: "mismatched_organization",
      message:
        "OpenAI-Organization header should match organization for API key",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota]: {
    provider: "openai",
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: "Quota exhausted",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled]: {
    provider: "google",
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "API not enabled for project",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          domain: "googleapis.com",
        },
      ],
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.googleKeyRestricted]: {
    provider: "google",
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Requests from this referer are blocked",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "API_KEY_HTTP_REFERRER_BLOCKED",
          domain: "googleapis.com",
        },
      ],
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.openrouterNoCredits]: {
    provider: "openrouter",
    error: { code: 402, message: "Insufficient credits" },
  },
  [PROVIDER_SETUP_ERROR_CODE.azureModelNotEnabled]: {
    provider: "azure_foundry",
    error: {
      code: "DeploymentNotFound",
      message: "The API deployment for this resource does not exist.",
    },
  },
  [PROVIDER_SETUP_ERROR_CODE.bedrockModelNotEnabled]: {
    provider: "bedrock",
    error: {
      code: "AccessDeniedException",
      message: "Access to the model is denied",
    },
  },
} as const satisfies Record<
  ProviderSetupErrorCode,
  Parameters<typeof identifyProviderSetupError>[0]
>;
