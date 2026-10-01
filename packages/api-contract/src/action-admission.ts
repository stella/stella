export const ACTION_ADMISSION_CODES = {
  periodExhausted: "action_period_exhausted",
  concurrencyBusy: "action_concurrency_busy",
  notEnabled: "action_not_enabled",
  admissionUnavailable: "action_admission_unavailable",
} as const;

export type ActionAdmissionCode =
  (typeof ACTION_ADMISSION_CODES)[keyof typeof ACTION_ADMISSION_CODES];

// Exhaustion and unavailable access must not trigger transient HTTP retries.
// Recovery time is unknown; responses expose neither limits nor reset headers.
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
  [ACTION_ADMISSION_CODES.admissionUnavailable]: {
    status: 503,
    message: "This action is temporarily paused. Please try again shortly.",
    hint: "Wait for the service to recover, then retry this call.",
    retryable: true,
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
  contactUrl?: string;
};
