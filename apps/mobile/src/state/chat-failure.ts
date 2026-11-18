import * as v from "valibot";

import {
  AI_ERROR_KINDS,
  AI_FAILURE_CODES,
  isFixedInDesktopSettings,
} from "@stll/api-contract/ai-errors";
import type { AIErrorKind } from "@stll/api-contract/ai-errors";

import type { MobileMessages } from "@/i18n/catalogs";

const failedOutcomeSchema = v.looseObject({
  turnOutcome: v.looseObject({
    type: v.literal("failed"),
    error: v.optional(v.unknown()),
  }),
});

/**
 * Why a stored answer's turn failed, read from the message's metadata, or
 * undefined for a turn that did not fail. A kind this build does not know
 * yet reads as `unknown`, which has a text of its own.
 */
export const storedTurnFailure = (
  metadata: unknown,
): AIErrorKind | undefined => {
  const parsed = v.safeParse(failedOutcomeSchema, metadata);
  if (!parsed.success) {
    return undefined;
  }
  const { error } = parsed.output.turnOutcome;
  return AI_ERROR_KINDS.find((kind) => kind === error) ?? "unknown";
};

/** Why a streamed run failed, from the failure code its error event carries. */
export const streamedTurnFailure = (code: unknown): AIErrorKind =>
  AI_ERROR_KINDS.find((kind) => AI_FAILURE_CODES[kind] === code) ?? "unknown";

/**
 * What each failure tells the person, by key under `chat.failure`. Total
 * over the kinds, so a new kind cannot ship without a text; the texts are
 * the web's, in every locale.
 */
export const CHAT_FAILURE_KEYS = {
  quota_exhausted: "sendErrorQuotaExhausted",
  provider_billing: "sendErrorProviderBilling",
  provider_credentials_rejected: "sendErrorProviderCredentialsRejected",
  model_unavailable: "sendErrorModelUnavailable",
  provider_unavailable: "sendErrorProviderUnavailable",
  provider_stream_incomplete: "sendErrorStreamIncomplete",
  output_incomplete: "sendErrorStreamIncomplete",
  output_moderated: "aiOutputModerated",
  output_invalid: "aiOutputInvalid",
  deadline_exceeded: "aiDeadlineExceeded",
  loop_detected: "sendErrorLoopDetected",
  empty_completion: "sendErrorEmptyCompletion",
  turn_too_large: "sendErrorTurnTooLarge",
  local_runner_needs_login: "errorNeedsLogin",
  local_runner_limit_reached: "errorLimitReached",
  local_runner_unavailable: "errorUnavailable",
  local_runner_turn_too_large: "refusalTooLarge",
  local_runner_not_reached: "errorNotReached",
  local_runner_relinked: "errorRelinked",
  local_runner_restoring: "errorRestoring",
  local_runner_folder_unavailable: "errorFolderUnavailable",
  local_runner_no_computer: "refusalNoComputer",
  local_runner_harness_unavailable: "refusalHarnessUnavailable",
  local_runner_model_unavailable: "refusalModelUnavailable",
  local_runner_reasoning_effort_unavailable:
    "refusalReasoningEffortUnavailable",
  local_runner_approvals_unavailable: "refusalPermissionUnavailable",
  local_runner_folder_not_approved: "refusalFolderNotApproved",
  unknown: "aiUnknown",
} as const satisfies Record<
  AIErrorKind,
  keyof MobileMessages["chat"]["failure"]
>;

const DESKTOP_SETTINGS_STEPS =
  "desktopSettingsSteps" satisfies keyof MobileMessages["chat"]["localRun"];

/**
 * The way to the fix a failure adds under its reason, by key under
 * `chat.localRun`, or `null` when it adds none. An agent to sign in or
 * install is fixed in stella desktop's Settings on the person's computer,
 * which the phone cannot open, so it says where that is; the web says the
 * same beside its button that opens it.
 */
export const chatFailureStepsKey = (failure: AIErrorKind) =>
  isFixedInDesktopSettings(failure) ? DESKTOP_SETTINGS_STEPS : null;
