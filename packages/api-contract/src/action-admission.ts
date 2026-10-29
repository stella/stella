export const LIMITER_STORE_UNAVAILABLE = {
  code: "limiter_store_unavailable",
  status: 503,
  message: "Limiter/admission store is unavailable. Retry later.",
  hint: "Wait for the service to recover, then retry this call.",
  retryable: true,
} as const;

export const ACTION_ADMISSION_CODES = {
  periodExhausted: "action_period_exhausted",
  concurrencyBusy: "action_concurrency_busy",
  notEnabled: "action_not_enabled",
  storeUnavailable: LIMITER_STORE_UNAVAILABLE.code,
  configurationIncomplete: "action_admission_configuration_incomplete",
  organizationStateUnreadable: "action_admission_org_state_unreadable",
  leaseLost: "action_admission_lease_lost",
  featureDisabled: "action_feature_disabled",
} as const;

export type ActionAdmissionCode =
  (typeof ACTION_ADMISSION_CODES)[keyof typeof ACTION_ADMISSION_CODES];

// Refusals expose neither limits nor reset headers.
export const ACTION_ADMISSION_REFUSALS = {
  [ACTION_ADMISSION_CODES.periodExhausted]: {
    status: 403,
    message: "This action is paused for your organization.",
    hint: "Contact your administrator for help. Do not retry this call immediately.",
    retryable: false,
  },
  [ACTION_ADMISSION_CODES.concurrencyBusy]: {
    status: 429,
    message: "Other work is in progress. Please try again shortly.",
    hint: "Wait for active work to finish, then retry this call.",
    retryable: true,
  },
  [ACTION_ADMISSION_CODES.notEnabled]: {
    status: 403,
    message: "This action is not enabled for your organization.",
    hint: "Contact your administrator to enable this action before retrying.",
    retryable: false,
  },
  [ACTION_ADMISSION_CODES.storeUnavailable]: {
    status: LIMITER_STORE_UNAVAILABLE.status,
    message: LIMITER_STORE_UNAVAILABLE.message,
    hint: LIMITER_STORE_UNAVAILABLE.hint,
    retryable: LIMITER_STORE_UNAVAILABLE.retryable,
  },
  [ACTION_ADMISSION_CODES.configurationIncomplete]: {
    status: 503,
    message: "Action admission configuration is incomplete.",
    hint: "Contact the service administrator to complete the configuration.",
    retryable: false,
  },
  [ACTION_ADMISSION_CODES.organizationStateUnreadable]: {
    status: 503,
    message: "Organization access state could not be read.",
    hint: "Wait for the service to recover, then retry this call.",
    retryable: true,
  },
  [ACTION_ADMISSION_CODES.leaseLost]: {
    status: 503,
    message: "The action reservation expired.",
    hint: "Retry this call to reserve capacity again.",
    retryable: true,
  },
  // An operator turned the feature off; nothing the caller does brings it back.
  [ACTION_ADMISSION_CODES.featureDisabled]: {
    status: 503,
    message: "This feature is temporarily turned off.",
    hint: "Do not retry this call until the feature is turned back on.",
    retryable: false,
  },
} as const satisfies Record<
  ActionAdmissionCode,
  { status: number; message: string; hint: string; retryable: boolean }
>;

export const isActionAdmissionCode = (
  code: unknown,
): code is ActionAdmissionCode =>
  typeof code === "string" && Object.hasOwn(ACTION_ADMISSION_REFUSALS, code);

export type ActionAdmissionRefusal = {
  code: ActionAdmissionCode;
  message: string;
  hint: string;
  retryable: boolean;
  retryAfterMs?: number;
  contactUrl?: string;
};
