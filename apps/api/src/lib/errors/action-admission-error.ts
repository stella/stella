import { TaggedError } from "better-result";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionCode,
} from "@stll/api-contract/action-admission";

export class ActionAdmissionError extends TaggedError("ActionAdmissionError")<{
  message: string;
  reason: "busy" | "period_exhausted" | "not_enabled" | "unavailable";
  cause?: unknown;
}> {
  get code() {
    return ADMISSION_REASON_CODES[this.reason];
  }
}

const ADMISSION_REASON_CODES = {
  busy: ACTION_ADMISSION_CODES.concurrencyBusy,
  period_exhausted: ACTION_ADMISSION_CODES.periodExhausted,
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
