import type { ApiKeyKind } from "@/api/lib/machine-api-key-config";
import { MACHINE_API_KEY_START_LENGTH } from "@/api/lib/machine-api-key-config";
import { logger } from "@/api/lib/observability/logger";
import { getCurrentRequestId } from "@/api/lib/observability/request-context";
import type { McpMode } from "@/api/mcp/constants";

export const API_KEY_REFUSAL_REASON = {
  invalid: "invalid",
  disabled: "disabled",
  invalidMetadata: "invalid_metadata",
  audienceMismatch: "audience_mismatch",
  invalidPermissions: "invalid_permissions",
  inactiveMember: "inactive_member",
  rolePermissions: "role_permissions",
  personalPolicy: "personal_policy",
  expired: "expired",
} as const;

export type ApiKeyRefusalReason =
  (typeof API_KEY_REFUSAL_REASON)[keyof typeof API_KEY_REFUSAL_REASON];

type ApiKeyRefusalOptions = {
  reason: ApiKeyRefusalReason;
  mode: McpMode | "self_inspection" | "desktop";
  key?: { start?: string | null; kind?: ApiKeyKind };
  requestId?: string;
};

/** Only the stored public start enters telemetry; the presented key is never an input. */
export const describeApiKeyRefusal = ({
  reason,
  mode,
  key,
  requestId,
}: ApiKeyRefusalOptions) => ({
  "auth.refusal_reason": reason,
  "auth.mode": mode,
  ...(typeof key?.start === "string"
    ? { "key.start": key.start.slice(0, MACHINE_API_KEY_START_LENGTH) }
    : {}),
  ...(key?.kind === undefined ? {} : { "key.kind": key.kind }),
  ...(requestId === undefined ? {} : { "request.id": requestId }),
});

export const logApiKeyRefusal = (
  options: Omit<ApiKeyRefusalOptions, "requestId">,
): void => {
  const requestId = getCurrentRequestId();
  logger.warn(
    "auth.api_key_refused",
    describeApiKeyRefusal({
      ...options,
      ...(requestId === undefined ? {} : { requestId }),
    }),
  );
};

export const apiKeyVerificationRefusalReason = (
  code: string | undefined,
): ApiKeyRefusalReason => {
  if (code === undefined) {
    return API_KEY_REFUSAL_REASON.invalid;
  }
  switch (code) {
    case "KEY_EXPIRED":
      return API_KEY_REFUSAL_REASON.expired;
    case "KEY_DISABLED":
      return API_KEY_REFUSAL_REASON.disabled;
    default:
      return API_KEY_REFUSAL_REASON.invalid;
  }
};
