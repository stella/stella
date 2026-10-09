import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

type ProviderSetupErrorOptions = {
  provider: string;
  error: Record<string, unknown> | undefined;
};

export const identifyProviderSetupError = ({
  provider,
  error,
}: ProviderSetupErrorOptions): ProviderSetupErrorCode | undefined => {
  if (provider !== "anthropic" || error === undefined) {
    return undefined;
  }
  const code = error["code"];
  // Anthropic's invalid_request_error does not identify the workspace issue
  // with a dedicated code. Match its field-specific diagnostic only then.
  const message = error["message"];
  if (
    code === undefined &&
    error["type"] === "invalid_request_error" &&
    typeof message === "string" &&
    message.includes("anthropic-workspace-id") &&
    (message.includes("not scoped to a workspace") ||
      message.includes(
        "is required when authenticating with an identity-linked API key",
      ))
  ) {
    return PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired;
  }
  return undefined;
};
