import { TaggedError } from "better-result";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionCode,
} from "@stll/api-contract/action-admission";

type ActionAdmissionReason =
  | "busy"
  | "period_exhausted"
  | "daily_exhausted"
  | "not_enabled"
  | "not_on_plan"
  | "unavailable";

// A daily refusal knows when its budget resets. An action period refusal
// names its window's reset; the MCP read fence's window refusal does not. No
// other refusal may claim one.
type ActionAdmissionErrorProps = { message: string; cause?: unknown } & (
  | { reason: "daily_exhausted"; retryAtMs: number }
  | { reason: "period_exhausted"; retryAtMs?: number }
  | {
      reason: Exclude<
        ActionAdmissionReason,
        "daily_exhausted" | "period_exhausted"
      >;
      retryAtMs?: never;
    }
);

// TaggedError cannot take a union of props, so the constructor binds
// `retryAtMs` to the exhausted reasons and the base keeps the shared fields.
export class ActionAdmissionError extends TaggedError("ActionAdmissionError")<{
  message: string;
  reason: ActionAdmissionReason;
  cause?: unknown;
}> {
  /** Epoch milliseconds at which an exhausted budget resets. */
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
  // A helper the plan does not offer answers as not enabled on the wire.
  not_on_plan: ACTION_ADMISSION_CODES.notEnabled,
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
  const contactUrl =
    error.code === ACTION_ADMISSION_CODES.periodExhausted ||
    error.code === ACTION_ADMISSION_CODES.notEnabled
      ? configuredContactUrl
      : undefined;
  return {
    ...refusal,
    code: error.code,
    hint:
      contactUrl === undefined
        ? refusal.hint
        : `${refusal.hint} Contact: ${contactUrl}`,
    ...(contactUrl === undefined ? {} : { contactUrl }),
  };
};
