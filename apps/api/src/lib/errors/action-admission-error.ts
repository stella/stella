import { TaggedError } from "better-result";

import {
  ACTION_ADMISSION_CODES,
  ORGANIZATION_UPGRADE_HINT,
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionCode,
} from "@stll/api-contract/action-admission";

type ActionAdmissionReason =
  | "busy"
  | "period_exhausted"
  | "daily_exhausted"
  | "not_enabled"
  | "unavailable";

// A daily refusal knows when its budget resets; no other refusal may claim one.
type ActionAdmissionErrorProps = {
  message: string;
  cause?: unknown;
  upgradeUrl?: string;
} & (
  | { reason: "daily_exhausted"; retryAtMs: number }
  | {
      reason: Exclude<ActionAdmissionReason, "daily_exhausted">;
      retryAtMs?: never;
    }
);

// TaggedError cannot take a union of props, so the constructor binds
// `retryAtMs` to the daily reason and the base keeps the shared fields.
export class ActionAdmissionError extends TaggedError("ActionAdmissionError")<{
  message: string;
  reason: ActionAdmissionReason;
  cause?: unknown;
  upgradeUrl?: string;
}> {
  /** Epoch milliseconds at which a `daily_exhausted` budget resets. */
  readonly retryAtMs: number | undefined;

  constructor({ retryAtMs, ...props }: ActionAdmissionErrorProps) {
    super(props);
    this.retryAtMs = retryAtMs;
  }

  get code() {
    return ADMISSION_REASON_CODES[this.reason];
  }
}

const ADMISSION_REASON_CODES = {
  busy: ACTION_ADMISSION_CODES.concurrencyBusy,
  period_exhausted: ACTION_ADMISSION_CODES.periodExhausted,
  daily_exhausted: ACTION_ADMISSION_CODES.periodExhausted,
  not_enabled: ACTION_ADMISSION_CODES.notEnabled,
  unavailable: ACTION_ADMISSION_CODES.admissionUnavailable,
} as const satisfies Record<
  ActionAdmissionError["reason"],
  ActionAdmissionCode
>;

export const actionAdmissionRefusal = (
  error: ActionAdmissionError,
  configuredContactUrl?: string,
) => {
  const refusal = ACTION_ADMISSION_REFUSALS[error.code];
  const upgradeUrl =
    error.reason === "period_exhausted" ? error.upgradeUrl : undefined;
  const contactUrl =
    error.code === ACTION_ADMISSION_CODES.periodExhausted ||
    error.code === ACTION_ADMISSION_CODES.notEnabled
      ? configuredContactUrl
      : undefined;
  const contactHint =
    contactUrl === undefined
      ? refusal.hint
      : `${refusal.hint} Contact: ${contactUrl}`;
  const hint =
    upgradeUrl === undefined ? contactHint : ORGANIZATION_UPGRADE_HINT;
  return {
    ...refusal,
    code: error.code,
    hint,
    ...(contactUrl === undefined ? {} : { contactUrl }),
    ...(upgradeUrl === undefined ? {} : { upgradeUrl }),
  };
};
