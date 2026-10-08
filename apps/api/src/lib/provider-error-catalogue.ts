import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import { isRecord } from "@/api/lib/type-guards";

type ProviderSetupErrorOptions = {
  provider: string;
  error: Record<string, unknown> | undefined;
};

const identifyAnthropicSetupError = (
  error: Record<string, unknown>,
): ProviderSetupErrorCode | undefined => {
  const code = error["code"];
  const type = error["type"];
  const message = typeof error["message"] === "string" ? error["message"] : "";
  if (code === "workspace_required" || code === "missing_workspace_id") {
    return PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired;
  }
  if (type === "billing_error") {
    return PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits;
  }
  if (type === "permission_error") {
    return PROVIDER_SETUP_ERROR_CODE.anthropicOrganizationRestricted;
  }
  // These generic Anthropic types have no setup-specific code.
  if (code !== undefined && code !== null) {
    return undefined;
  }
  if (type === "authentication_error") {
    if (message.includes("OAuth authentication is currently not supported")) {
      return PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken;
    }
    if (
      message.includes("deactivated") ||
      message.includes("disabled") ||
      message.includes("revoked") ||
      message.includes("expired")
    ) {
      return PROVIDER_SETUP_ERROR_CODE.anthropicKeyDisabled;
    }
  }
  if (type !== "invalid_request_error") {
    return undefined;
  }
  if (
    message.includes("anthropic-workspace-id") &&
    (message.includes("not scoped to a workspace") ||
      message.includes(
        "is required when authenticating with an identity-linked API key",
      ))
  ) {
    return PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired;
  }
  if (
    message.toLowerCase().includes("credit balance") &&
    message.toLowerCase().includes("too low")
  ) {
    return PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits;
  }
  return undefined;
};

export const identifyProviderSetupError = ({
  provider,
  error,
}: ProviderSetupErrorOptions): ProviderSetupErrorCode | undefined => {
  if (error === undefined) {
    return undefined;
  }
  const code = error["code"];
  const type = error["type"];
  switch (provider) {
    case "anthropic":
      return identifyAnthropicSetupError(error);
    case "openai":
      if (code === "mismatched_organization" || code === "invalid_project") {
        return PROVIDER_SETUP_ERROR_CODE.openaiProjectOrganizationMismatch;
      }
      if (
        code === "insufficient_quota" ||
        code === "credit_balance_exhausted" ||
        code === "organization_spend_limit_exceeded" ||
        code === "project_spend_limit_exceeded" ||
        code === "organization_usage_limit_exceeded" ||
        ((code === undefined || code === null) && type === "insufficient_quota")
      ) {
        return PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota;
      }
      return undefined;
    case "google": {
      const details = error["details"];
      if (!Array.isArray(details)) {
        return undefined;
      }
      for (const detail of details) {
        if (
          !isRecord(detail) ||
          detail["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo"
        ) {
          continue;
        }
        switch (detail["reason"]) {
          case "SERVICE_DISABLED":
            return PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled;
          case "API_KEY_HTTP_REFERRER_BLOCKED":
          case "API_KEY_IP_ADDRESS_BLOCKED":
          case "API_KEY_SERVICE_BLOCKED":
            return PROVIDER_SETUP_ERROR_CODE.googleKeyRestricted;
        }
      }
      return undefined;
    }
    case "openrouter":
      return code === 402
        ? PROVIDER_SETUP_ERROR_CODE.openrouterNoCredits
        : undefined;
    case "azure_foundry":
      return code === "DeploymentNotFound"
        ? PROVIDER_SETUP_ERROR_CODE.azureModelNotEnabled
        : undefined;
    case "bedrock":
      return code === "AccessDeniedException" ||
        error["name"] === "AccessDeniedException" ||
        error["__type"] === "AccessDeniedException"
        ? PROVIDER_SETUP_ERROR_CODE.bedrockModelNotEnabled
        : undefined;
    default:
      return undefined;
  }
};
