import { AI_ERROR_KINDS, AI_FAILURE_CODES } from "@stll/api-contract";
import type { AIErrorKind, AIFailureCode } from "@stll/api-contract";

import type { TranslationKey } from "@/i18n/types";

/**
 * What each AI failure tells the user, wherever it surfaces: a REST error, a
 * toast, a failed chat turn. Total over the codes, so a new code cannot ship
 * without a message of its own.
 */
export const AI_FAILURE_ERROR_KEYS = {
  [AI_FAILURE_CODES.quota_exhausted]: "chat.sendErrorQuotaExhausted",
  [AI_FAILURE_CODES.provider_billing]: "chat.sendErrorProviderBilling",
  [AI_FAILURE_CODES.provider_credentials_rejected]:
    "chat.sendErrorProviderCredentialsRejected",
  [AI_FAILURE_CODES.model_unavailable]: "chat.sendErrorModelUnavailable",
  [AI_FAILURE_CODES.provider_unavailable]: "chat.sendErrorProviderUnavailable",
  [AI_FAILURE_CODES.provider_stream_incomplete]:
    "chat.sendErrorStreamIncomplete",
  [AI_FAILURE_CODES.output_incomplete]: "chat.sendErrorStreamIncomplete",
  [AI_FAILURE_CODES.output_moderated]: "errors.apiCodes.aiOutputModerated",
  [AI_FAILURE_CODES.output_invalid]: "errors.apiCodes.aiOutputInvalid",
  [AI_FAILURE_CODES.deadline_exceeded]: "errors.apiCodes.aiDeadlineExceeded",
  [AI_FAILURE_CODES.loop_detected]: "chat.sendErrorLoopDetected",
  [AI_FAILURE_CODES.empty_completion]: "chat.sendErrorEmptyCompletion",
  [AI_FAILURE_CODES.unknown]: "errors.apiCodes.aiUnknown",
  [AI_FAILURE_CODES.role_not_configured]: "capabilityActions.aiMissing",
  [AI_FAILURE_CODES.own_key_required]: "capabilityActions.aiMissing",
  [AI_FAILURE_CODES.provider_task_unsupported]:
    "errors.apiCodes.aiProviderTaskUnsupported",
  [AI_FAILURE_CODES.managed_provider_unavailable]:
    "capabilityActions.aiMissing",
} as const satisfies Record<AIFailureCode, TranslationKey>;

export type AIFailureTranslationKey =
  (typeof AI_FAILURE_ERROR_KEYS)[AIFailureCode];

/** The chat stream ends a failed turn with the AI error kind as its message. */
export const aiErrorKindFromMessage = (
  message: string,
): AIErrorKind | undefined => AI_ERROR_KINDS.find((kind) => kind === message);
