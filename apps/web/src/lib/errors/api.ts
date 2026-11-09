import { isTaggedError, panic, TaggedError } from "better-result";
import * as v from "valibot";

import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  API_VALIDATION_ERROR_CODE,
  API_VERSION_CONFLICT_ERROR_CODE,
  type ApiValidationIssue,
  CHAT_INPUT_REFUSAL_CODE,
  CHAT_MESSAGE_EMPTY_ERROR_CODE,
  type ChatInputRefusalCode,
  CLAUSE_DIRECTIVES_INVALID_CODE,
  CLAUSE_VERSION_LIMIT_ERROR_CODE,
  ENCRYPTED_CONTENT_ERROR_CODE,
  IDEMPOTENCY_IN_PROGRESS_CODE,
  IDEMPOTENCY_KEY_REUSED_CODE,
  MEMBER_REMOVAL_BUSY_CODE,
  normalizeApiError,
  parseApiErrorValue,
  parseApiValidationIssues,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
} from "@stll/api-contract";
import {
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
} from "@stll/api-contract/action-admission";
import { BROWSER_SITE_GRANT_REFUSAL_CODE } from "@stll/api-contract/browser-site-grants";
import {
  CHAT_LOCAL_RUN_REFUSAL,
  type ChatLocalRunRefusal,
} from "@stll/api-contract/chat-run-target";
import { CORRESPONDENCE_SOURCE_CHANGED_CODE } from "@stll/api-contract/correspondence";
import { ORGANIZATION_DATA_BOX_REFUSAL_CODE } from "@stll/api-contract/data-box";
import { HOSTED_CHECKOUT_REFUSAL_CODE } from "@stll/api-contract/hosted-checkout";
import { FILE_PROPERTY_TYPE_IMMUTABLE_CODE } from "@stll/api-contract/property-policy";
import { providerDiagnosticSchema } from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import {
  PUBLIC_COUNTRY_UNAVAILABLE_CODE,
  type PublicCountryUnavailable,
  publicCountryUnavailableSchema,
  type PublicLawDomain,
} from "@stll/api-contract/public-country-capability";
import { TIME_ENTRY_RATE_REQUIRED_CODE } from "@stll/api-contract/time-entries";
import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";
import type { VerificationRunCapCode } from "@stll/api-contract/verification-run-caps";
import { MATTER_CONTACT_CAPACITY_CODE } from "@stll/api-contract/workspace-contacts";

import { getTranslator } from "@/i18n/translator";
import type { TranslationKey } from "@/i18n/types";
import { AI_FAILURE_ERROR_KEYS } from "@/lib/errors/ai-failure";
import { API_ERROR_TAG } from "@/lib/errors/api-tag";
import { ClientOperationError } from "@/lib/errors/client";
import { INVOICE_ISSUE_ERROR_KEYS } from "@/lib/errors/invoice-issue";
import {
  ACTION_ADMISSION_ERROR_KEYS,
  STATUS_ERROR_KEYS,
  STATUS_TO_KEY,
  translateError,
} from "@/lib/errors/localization";
import { uploadFileTooLargeMessage } from "@/lib/files/upload-file-validation";

export class APIError extends TaggedError(API_ERROR_TAG)<{
  code?: string | undefined;
  status: number;
  message: string;
  rawMessage?: string | undefined;
  details?: Record<string, unknown> | undefined;
  providerDiagnostic?: ProviderDiagnostic | undefined;
  transportKind?: "network" | "timeout" | "aborted" | undefined;
  cause?: unknown;
}> {}

export const isCancellation = (error: unknown): boolean =>
  (APIError.is(error) && error.transportKind === "aborted") ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

const MAX_API_RETRY_COUNT = 3;
const CLIENT_ERROR_STATUS = 400;
const TOO_MANY_REQUESTS_STATUS = 429;
const SERVER_ERROR_STATUS = 500;

const isClientErrorStatus = (status: number): boolean =>
  status >= CLIENT_ERROR_STATUS && status < SERVER_ERROR_STATUS;

export const shouldRetryAPIRequest = (
  failureCount: number,
  error: unknown,
): boolean => {
  if (APIError.is(error) && error.code === PUBLIC_COUNTRY_UNAVAILABLE_CODE) {
    return false;
  }
  if (APIError.is(error) && isActionAdmissionCode(error.code)) {
    return (
      failureCount < MAX_API_RETRY_COUNT &&
      ACTION_ADMISSION_REFUSALS[error.code].retryable
    );
  }
  if (APIError.is(error) && error.transportKind !== undefined) {
    return (
      failureCount < MAX_API_RETRY_COUNT && error.transportKind !== "aborted"
    );
  }
  // Any other typed error is a deliberate outcome (a disabled surface, a
  // refused operation), never a transient one: asking again cannot change it.
  if (!APIError.is(error) && isTaggedError(error)) {
    return false;
  }
  return (
    failureCount < MAX_API_RETRY_COUNT &&
    (!APIError.is(error) ||
      error.status === TOO_MANY_REQUESTS_STATUS ||
      error.status >= 500)
  );
};

const SERVICE_UNAVAILABLE_STATUS = 503;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;
/** The body field a refusal's `Retry-After` is carried in. */
export const RETRY_AFTER_MS_DETAIL = "retryAfterMs";

/** How long a 503 said to wait before asking again, when it said. */
export const serviceBusyRetryAfterMs = (error: unknown): number | undefined => {
  if (!APIError.is(error) || error.status !== SERVICE_UNAVAILABLE_STATUS) {
    return undefined;
  }
  const value = error.details?.[RETRY_AFTER_MS_DETAIL];
  return typeof value === "number" ? value : undefined;
};

/** TanStack's default backoff, unless the server named a delay. */
export const apiRetryDelayMs = (attemptIndex: number, error: unknown): number =>
  serviceBusyRetryAfterMs(error) ??
  Math.min(DEFAULT_RETRY_BASE_MS * 2 ** attemptIndex, DEFAULT_RETRY_MAX_MS);

export type ToAPIErrorProps = {
  status: number;
  value: unknown;
  kind?: "network" | "timeout" | "aborted" | undefined;
  cause?: unknown;
};

export type ApiResponse<T> =
  { data: T; error: null } | { data: null; error: ToAPIErrorProps };

/**
 * Unwraps an API client response: throws a localized {@link APIError} when the
 * response carries an error, otherwise returns `response.data`.
 *
 * `T` is inferred from the response's success branch, so nullable payloads (e.g.
 * public-law endpoints whose `data` is `X | null`) keep their nullability at the
 * call site. Do not pass an explicit type argument; let inference flow.
 */
export function unwrapApiResponse<T>(response: ApiResponse<T>): T {
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data;
}

export const toAPIError = (error: ToAPIErrorProps): APIError => {
  if (error.kind !== undefined) {
    const t = getTranslator();
    let message: string;
    switch (error.kind) {
      case "network":
        message = t("common.networkError");
        break;
      case "timeout":
        message = t("transportErrors.timeout");
        break;
      case "aborted":
        message = "Request aborted";
        break;
      default:
        error.kind satisfies never;
        panic("Unknown API transport kind", error.kind);
    }
    return new APIError({
      status: error.status,
      transportKind: error.kind,
      cause: error.cause,
      message,
    });
  }
  const { status, value } = error;
  const normalized = normalizeApiError({
    status,
    value: parseApiErrorValue(value),
  });
  const { code, details, rawMessage } = normalized;
  const countryRefusal =
    code === PUBLIC_COUNTRY_UNAVAILABLE_CODE
      ? v.safeParse(publicCountryUnavailableSchema, value)
      : undefined;
  const diagnosticValue = details?.["providerDiagnostic"];
  const diagnostic =
    diagnosticValue === undefined
      ? undefined
      : v.safeParse(providerDiagnosticSchema, diagnosticValue);
  let malformedResponse =
    countryRefusal?.success === false
      ? {
          action: "parse-public-country-unavailable",
          message: "Invalid public country unavailability response",
        }
      : null;
  if (malformedResponse === null && diagnostic?.success === false) {
    malformedResponse = {
      action: "parse-provider-diagnostic",
      message: "Invalid provider diagnostic response",
    };
  }
  if (malformedResponse !== null) {
    throw new ClientOperationError(malformedResponse);
  }
  return new APIError({
    ...(diagnostic?.success ? { providerDiagnostic: diagnostic.output } : {}),
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
    ...(rawMessage === undefined ? {} : { rawMessage }),
    status: normalized.status,
    message: countryRefusal?.success
      ? translateError(
          PUBLIC_COUNTRY_ERROR_KEYS[countryRefusal.output.domain][
            countryRefusal.output.reason
          ],
        )
      : localizeAPIError({ code, details, status: normalized.status }),
  });
};

const PUBLIC_COUNTRY_ERROR_KEYS = {
  caseLaw: {
    identity_public: "errors.api.caseLawIdentityOnly",
    pending_public: "errors.api.caseLawCountryUnavailable",
    withdrawn: "errors.api.caseLawCountryUnavailable",
    pages_public: "errors.api.caseLawSearchUnavailable",
  },
  legislation: {
    identity_public: "errors.api.legislationIdentityOnly",
    pending_public: "errors.api.legislationCountryUnavailable",
    withdrawn: "errors.api.legislationCountryUnavailable",
    pages_public: "errors.api.legislationSearchUnavailable",
  },
} as const satisfies Record<
  PublicLawDomain,
  Record<PublicCountryUnavailable["reason"], TranslationKey>
>;

const RAW_INTERNAL_TOOL_ERROR_CODE = {
  legalSourceStructuralRepairRequired:
    "legal_source_structural_repair_required",
} as const;

const VERIFICATION_RUN_CAP_ERROR_KEYS = {
  [VERIFICATION_RUN_CAP_CODES.active]:
    "errors.apiCodes.verificationActiveLimitReached",
  [VERIFICATION_RUN_CAP_CODES.daily]:
    "errors.apiCodes.verificationDailyLimitReached",
} as const satisfies Record<VerificationRunCapCode, TranslationKey>;

/** Why a chat turn bound for the member's computer was refused. */
const CHAT_LOCAL_RUN_REFUSAL_ERROR_KEYS = {
  [CHAT_LOCAL_RUN_REFUSAL.unavailable]: "chat.localRun.refusalUnavailable",
  [CHAT_LOCAL_RUN_REFUSAL.noComputer]: "chat.localRun.refusalNoComputer",
  [CHAT_LOCAL_RUN_REFUSAL.harnessUnavailable]:
    "chat.localRun.refusalHarnessUnavailable",
  [CHAT_LOCAL_RUN_REFUSAL.modelUnavailable]:
    "chat.localRun.refusalModelUnavailable",
  [CHAT_LOCAL_RUN_REFUSAL.approvalsUnavailable]:
    "chat.localRun.refusalPermissionUnavailable",
  [CHAT_LOCAL_RUN_REFUSAL.approvalsAboveLimit]:
    "chat.localRun.refusalPermissionAboveLimit",
  [CHAT_LOCAL_RUN_REFUSAL.tooLarge]: "chat.localRun.refusalTooLarge",
  [CHAT_LOCAL_RUN_REFUSAL.conflictingRunMode]:
    "chat.localRun.refusalConflictingRunMode",
} as const satisfies Record<ChatLocalRunRefusal, TranslationKey>;

/** Why a chat turn was refused before it started, with what the person can do. */
const CHAT_INPUT_REFUSAL_ERROR_KEYS = {
  [CHAT_INPUT_REFUSAL_CODE.activeFileNoText]: "chat.sendErrorActiveFileNoText",
  [CHAT_INPUT_REFUSAL_CODE.activeFileTooLarge]:
    "chat.sendErrorActiveFileTooLarge",
  [CHAT_INPUT_REFUSAL_CODE.agentRunsDisabled]:
    "chat.sendErrorAgentRunsDisabled",
  [CHAT_INPUT_REFUSAL_CODE.attachmentNoText]: "chat.sendErrorAttachmentNoText",
  [CHAT_INPUT_REFUSAL_CODE.attachmentUnsupported]:
    "chat.sendErrorAttachmentUnsupported",
  [CHAT_INPUT_REFUSAL_CODE.documentUnsupported]:
    "chat.sendErrorDocumentUnsupported",
  [CHAT_INPUT_REFUSAL_CODE.imageInvalid]: "chat.sendErrorImageInvalid",
  [CHAT_INPUT_REFUSAL_CODE.imageUnsupported]: "chat.sendErrorImageUnsupported",
  [CHAT_INPUT_REFUSAL_CODE.toolsUnsupported]: "chat.sendErrorToolsUnsupported",
} as const satisfies Record<ChatInputRefusalCode, TranslationKey>;

const CODE_ERROR_KEYS = {
  [TIME_ENTRY_RATE_REQUIRED_CODE]: "billing.rates.effectiveRateRequired",
  [IDEMPOTENCY_IN_PROGRESS_CODE]: "errors.apiCodes.idempotencyInProgress",
  [IDEMPOTENCY_KEY_REUSED_CODE]: "errors.apiCodes.idempotencyKeyReused",
  ...AI_FAILURE_ERROR_KEYS,
  ...CHAT_LOCAL_RUN_REFUSAL_ERROR_KEYS,
  ...CHAT_INPUT_REFUSAL_ERROR_KEYS,
  ...VERIFICATION_RUN_CAP_ERROR_KEYS,
  ...INVOICE_ISSUE_ERROR_KEYS,
  [FILE_PROPERTY_TYPE_IMMUTABLE_CODE]:
    "errors.apiCodes.filePropertyTypeImmutable",
  [MATTER_CONTACT_CAPACITY_CODE.reached]:
    "errors.apiCodes.matterContactCapacityReached",
  [MATTER_CONTACT_CAPACITY_CODE.exceeded]:
    "errors.apiCodes.matterContactCapacityExceeded",
  [CORRESPONDENCE_SOURCE_CHANGED_CODE]:
    "errors.apiCodes.correspondenceSourceChanged",
  [ORGANIZATION_DATA_BOX_REFUSAL_CODE.limitReached]:
    "errors.apiCodes.organizationDataBoxLimitReached",
  [ORGANIZATION_DATA_BOX_REFUSAL_CODE.changedConcurrently]:
    "errors.apiCodes.organizationDataBoxesChanged",
  [BROWSER_SITE_GRANT_REFUSAL_CODE.limitReached]:
    "errors.apiCodes.browserSiteGrantLimitReached",
  [CHAT_MESSAGE_EMPTY_ERROR_CODE]: "chat.sendErrorMessageEmpty",
  [CLAUSE_DIRECTIVES_INVALID_CODE]: "errors.apiCodes.clauseDirectivesInvalid",
  [CLAUSE_VERSION_LIMIT_ERROR_CODE]: "clauses.versionLimitReached",
  [MEMBER_REMOVAL_BUSY_CODE]: "errors.actionAdmission.concurrencyBusy",
  access_denied: "errors.apiCodes.accessDenied",
  account_deletion_otp_expired: "errors.apiCodes.accountDeletionOtpExpired",
  account_deletion_otp_invalid: "errors.apiCodes.accountDeletionOtpInvalid",
  account_deletion_sole_owner: "errors.apiCodes.accountDeletionSoleOwner",
  account_deletion_task_reassignment_invalid:
    "errors.apiCodes.accountDeletionTaskReassignmentInvalid",
  account_deletion_task_reassignment_limit_exceeded:
    "errors.apiCodes.accountDeletionTaskReassignmentLimitExceeded",
  ai_config_decision_invalid: "errors.apiCodes.aiConfigDecisionInvalid",
  ai_config_decision_validation_failed:
    "errors.apiCodes.aiConfigDecisionValidationFailed",
  ai_config_model_invalid: "errors.apiCodes.aiConfigModelInvalid",
  ai_config_provider_invalid: "errors.apiCodes.aiConfigProviderInvalid",
  ai_config_provider_validation_failed:
    "errors.apiCodes.aiConfigProviderValidationFailed",
  deepl_key_rejected: "errors.apiCodes.deeplKeyRejected",
  deepl_quota_exceeded: "errors.apiCodes.deeplQuotaExceeded",
  [ENCRYPTED_CONTENT_ERROR_CODE]: "errors.apiCodes.encryptedContent",
  [PREVIEW_UNAVAILABLE_ERROR_CODE]: "search.previewUnavailable",
  [API_FILE_SECURITY_REJECTED_ERROR_CODE]:
    "errors.apiCodes.fileSecurityRejected",
  forbidden: "errors.apiCodes.forbidden",
  [HOSTED_CHECKOUT_REFUSAL_CODE.checkoutOpen]:
    "errors.apiCodes.hostedCheckoutOpen",
  [HOSTED_CHECKOUT_REFUSAL_CODE.subscriptionLive]:
    "errors.apiCodes.hostedSubscriptionLive",
  internal_server_error: "errors.apiCodes.internalServerError",
  legal_source_entity_limit_reached:
    "errors.apiCodes.legalSourceEntityLimitReached",
  legal_source_file_property_missing:
    "errors.apiCodes.legalSourceFilePropertyMissing",
  mcp_oauth_binding_invalid: "errors.apiCodes.mcpAuthorizationApprovalRequired",
  mcp_authorization_approval_required:
    "errors.apiCodes.mcpAuthorizationApprovalRequired",
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

/** The message for the first field a rejected request named. */
const validationIssueMessage = (issue: ApiValidationIssue): string => {
  const t = getTranslator();
  switch (issue.constraint) {
    case "maxLength":
      return issue.limit === undefined
        ? t("errors.apiCodes.validationInvalid")
        : t("errors.apiCodes.validationTooLong", { limit: issue.limit });
    case "minLength":
      return issue.limit === undefined
        ? t("errors.apiCodes.validationInvalid")
        : t("errors.apiCodes.validationTooShort", { limit: issue.limit });
    case "maxBytes":
      return issue.limit === undefined
        ? t("errors.apiCodes.validationInvalid")
        : uploadFileTooLargeMessage(issue.limit);
    case "required":
      return t("errors.apiCodes.validationRequired");
    case "invalid":
      return t("errors.apiCodes.validationInvalid");
    default:
      issue.constraint satisfies never;
      return panic(
        `Unhandled validation constraint: ${String(issue.constraint)}`,
      );
  }
};

/**
 * The message for a rejected request's issue on one body field, or
 * `undefined` when the error is not a validation answer naming that field.
 * Forms show it under the matching input instead of only in a toast.
 */
export const apiFieldIssueMessage = (
  error: unknown,
  field: string,
): string | undefined => {
  if (
    !APIError.is(error) ||
    error.code !== API_VALIDATION_ERROR_CODE ||
    !isClientErrorStatus(error.status)
  ) {
    return undefined;
  }
  const issue = parseApiValidationIssues(error.details).find(
    (candidate) => candidate.field === field,
  );
  return issue === undefined ? undefined : validationIssueMessage(issue);
};

/**
 * Codes that only restate a 401 or 403. `permission_denied` is the API's
 * refusal for both; the status tells them apart, so the status-keyed message
 * is the right text. Any other code on those statuses refuses something else
 * (a wrong password is a 401 too) and stays with the caller's own wording.
 */
const AUTH_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "permission_denied",
  "SESSION_EXPIRED",
  "UNAUTHORIZED",
]);

type AuthRefusalCandidate = { code?: string | undefined; status: number };

/** Whether this is a plain refusal of who is asking, whatever the action. */
const isAuthRefusal = ({ code, status }: AuthRefusalCandidate): boolean =>
  (status === 401 || status === 403) &&
  (code === undefined || AUTH_REFUSAL_CODES.has(code));

/** The session behind this request is gone; signing in again answers it. */
export const isSessionRefusal = (candidate: AuthRefusalCandidate): boolean =>
  candidate.status === 401 && isAuthRefusal(candidate);

/**
 * Codes the auth server sets when it turns down a code the person typed. Each
 * form that asks for one says so in place and lets them try again.
 */
const TYPED_CODE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "INVALID_BACKUP_CODE",
  "INVALID_CODE",
  "INVALID_OTP",
  "OTP_EXPIRED",
]);

/** Whether the auth server turned down a code the person typed. */
export const isTypedCodeRefusal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  TYPED_CODE_REFUSAL_CODES.has(error.code);

/** The server has nothing to show for this file; retrying cannot help. */
export const isPreviewUnavailableError = (error: unknown): boolean =>
  APIError.is(error) && error.code === PREVIEW_UNAVAILABLE_ERROR_CODE;

export const isDisplayableAPIError = (error: APIError): boolean =>
  isActionAdmissionCode(error.code) ||
  (typeof error.code === "string" && isKnownErrorCode(error.code)) ||
  isAuthRefusal(error) ||
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
  if (
    code === CLAUSE_DIRECTIVES_INVALID_CODE &&
    typeof details?.["clause"] === "object" &&
    details["clause"] !== null
  ) {
    const clause = details["clause"];
    if ("slotKey" in clause && typeof clause.slotKey === "string") {
      const clauseName =
        "name" in clause && typeof clause.name === "string"
          ? clause.name
          : clause.slotKey;
      const key =
        "resolution" in clause && clause.resolution === "override"
          ? "errors.apiCodes.clauseDirectivesOverrideInvalidDetails"
          : "errors.apiCodes.clauseDirectivesInvalidDetails";
      return getTranslator()(key, {
        slotName: clause.slotKey,
        clauseName,
      });
    }
  }
  if (isActionAdmissionCode(code)) {
    return translateError(ACTION_ADMISSION_ERROR_KEYS[code]);
  }
  // Only a rejected request (4xx) is a validation answer. An outage that
  // carries the code must keep the unavailable/retry message.
  const issue =
    code === API_VALIDATION_ERROR_CODE && isClientErrorStatus(status)
      ? parseApiValidationIssues(details).at(0)
      : undefined;
  if (issue !== undefined) {
    return validationIssueMessage(issue);
  }
  if (
    code &&
    isKnownErrorCode(code) &&
    !(code === API_VALIDATION_ERROR_CODE && !isClientErrorStatus(status))
  ) {
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

/**
 * The chat refusal an error carries, directly or as a cause: the API error
 * whose (already localized) message the chat should show, or `null`.
 * HTTP refusals never expose raw diagnostics: `toAPIError` localizes their
 * status/code before this boundary. Keep all of them through SDK wrappers.
 */
export const chatRefusal = (error: unknown): APIError | null => {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (APIError.is(current)) {
      return current;
    }
    current = current.cause;
  }
  return null;
};
