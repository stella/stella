import { Result, TaggedError } from "better-result";

import {
  API_VERSION_CONFLICT_ERROR_CODE,
  normalizeApiError,
} from "@stll/api-contract";
import type { ApiErrorInput } from "@stll/api-contract";

import type { TranslationKey } from "@/i18n/types";
import { API_ERROR_TAG } from "@/lib/errors/api-tag";
import {
  STATUS_ERROR_KEYS,
  STATUS_TO_KEY,
  translateError,
} from "@/lib/errors/localization";

export class APIError extends TaggedError(API_ERROR_TAG)<{
  code?: string | undefined;
  status: number;
  message: string;
  rawMessage?: string | undefined;
  details?: Record<string, unknown> | undefined;
}> {}

const MAX_API_RETRY_COUNT = 3;
const TOO_MANY_REQUESTS_STATUS = 429;

export const shouldRetryAPIRequest = (
  failureCount: number,
  error: unknown,
): boolean =>
  failureCount < MAX_API_RETRY_COUNT &&
  (!APIError.is(error) ||
    error.status === TOO_MANY_REQUESTS_STATUS ||
    error.status >= 500);

export type ToAPIErrorProps = ApiErrorInput;

export type EdenResponse<T> =
  | { data: T; error: null }
  | { data: null; error: ToAPIErrorProps };

/**
 * Unwraps an Eden treaty response: throws a localized {@link APIError} when the
 * response carries an error, otherwise returns `response.data`.
 *
 * `T` is inferred from the response's success branch, so nullable payloads (e.g.
 * public-law endpoints whose `data` is `X | null`) keep their nullability at the
 * call site. Do not pass an explicit type argument; let inference flow.
 */
export function unwrapEden<T>(response: EdenResponse<T>): T {
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data;
}

/**
 * The cause of a failed api call, or `null` when it succeeded.
 *
 * A transport failure (offline, reset connection) rejects the promise rather
 * than producing `response.error`, so a call wrapped in `Result.tryPromise` has
 * two failure shapes. Both resolve here to one cause, which is what a caller
 * that reports the same way for either one needs. Callers that also read the
 * payload branch on the `Result` themselves, so narrowing survives.
 */
export const edenCallFailure = <
  TResponse extends { error: ToAPIErrorProps | null },
  TCause,
>(
  requested: Result<TResponse, TCause>,
): unknown => {
  if (Result.isError(requested)) {
    return requested.error;
  }
  const { error } = requested.value;
  return error === null ? null : toAPIError(error);
};

export const toAPIError = (input: ToAPIErrorProps) => {
  const { code, details, rawMessage, status } = normalizeApiError(input);
  return new APIError({
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
    ...(rawMessage === undefined ? {} : { rawMessage }),
    status,
    message: localizeAPIError({ code, details, status }),
  });
};

const RAW_INTERNAL_TOOL_ERROR_CODE = {
  legalSourceStructuralRepairRequired:
    "legal_source_structural_repair_required",
} as const;

const CODE_ERROR_KEYS = {
  access_denied: "errors.apiCodes.accessDenied",
  account_deletion_otp_expired: "errors.apiCodes.accountDeletionOtpExpired",
  account_deletion_otp_invalid: "errors.apiCodes.accountDeletionOtpInvalid",
  account_deletion_sole_owner: "errors.apiCodes.accountDeletionSoleOwner",
  account_deletion_task_reassignment_invalid:
    "errors.apiCodes.accountDeletionTaskReassignmentInvalid",
  account_deletion_task_reassignment_limit_exceeded:
    "errors.apiCodes.accountDeletionTaskReassignmentLimitExceeded",
  ai_config_model_invalid: "errors.apiCodes.aiConfigModelInvalid",
  ai_config_provider_invalid: "errors.apiCodes.aiConfigProviderInvalid",
  ai_config_provider_validation_failed:
    "errors.apiCodes.aiConfigProviderValidationFailed",
  deepl_key_rejected: "errors.apiCodes.deeplKeyRejected",
  deepl_quota_exceeded: "errors.apiCodes.deeplQuotaExceeded",
  forbidden: "errors.apiCodes.forbidden",
  internal_server_error: "errors.apiCodes.internalServerError",
  legal_source_entity_limit_reached:
    "errors.apiCodes.legalSourceEntityLimitReached",
  legal_source_file_property_missing:
    "errors.apiCodes.legalSourceFilePropertyMissing",
  provider_key_rejected: "errors.apiCodes.providerKeyRejected",
  provider_rate_limited: "errors.apiCodes.providerRateLimited",
  third_party_boundary_refusal: "errors.apiCodes.thirdPartyBoundaryRefusal",
  usage_limit_exceeded: "errors.apiCodes.usageLimitExceeded",
  validation: STATUS_ERROR_KEYS.validation,
  [API_VERSION_CONFLICT_ERROR_CODE]: "errors.apiCodes.versionConflict",
} as const satisfies Record<string, TranslationKey>;

const USAGE_REJECTION_REASON_KEYS = {
  entitlement_inactive: CODE_ERROR_KEYS.usage_limit_exceeded,
  no_entitlement: CODE_ERROR_KEYS.usage_limit_exceeded,
  usage_limit_exceeded: CODE_ERROR_KEYS.usage_limit_exceeded,
} as const satisfies Record<string, TranslationKey>;

const isKnownErrorCode = (code: string): code is keyof typeof CODE_ERROR_KEYS =>
  Object.hasOwn(CODE_ERROR_KEYS, code);
const isUsageRejectionReason = (
  reason: string,
): reason is keyof typeof USAGE_REJECTION_REASON_KEYS =>
  Object.hasOwn(USAGE_REJECTION_REASON_KEYS, reason);

export const isDisplayableAPIError = (error: APIError): boolean =>
  (typeof error.code === "string" && isKnownErrorCode(error.code)) ||
  (error.status === 402 &&
    typeof error.details?.["reason"] === "string" &&
    isUsageRejectionReason(error.details["reason"]));

export const internalToolErrorMessage = (error: APIError): string => {
  if (
    error.code ===
      RAW_INTERNAL_TOOL_ERROR_CODE.legalSourceStructuralRepairRequired &&
    typeof error.rawMessage === "string"
  ) {
    return error.rawMessage;
  }
  return error.message;
};

type LocalizeAPIErrorInput = {
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
  status: number;
};

const localizeAPIError = ({ code, details, status }: LocalizeAPIErrorInput) => {
  if (code && isKnownErrorCode(code)) {
    return translateError(CODE_ERROR_KEYS[code]);
  }
  if (
    status === 402 &&
    typeof details?.["reason"] === "string" &&
    isUsageRejectionReason(details["reason"])
  ) {
    return translateError(USAGE_REJECTION_REASON_KEYS[details["reason"]]);
  }
  return translateError(STATUS_TO_KEY[status] ?? STATUS_ERROR_KEYS.unknown);
};
