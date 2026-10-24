import { TaggedError } from "better-result";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionCode,
} from "@stll/api-contract/action-admission";
import { declareFingerprintFields } from "@stll/errors";

import {
  KILL_SWITCHES,
  type KillSwitchId,
} from "@/api/lib/kill-switches/registry";

type ActionAdmissionReason =
  | "busy"
  | "period_exhausted"
  | "daily_exhausted"
  | "not_enabled"
  | "not_on_plan"
  | "unavailable"
  | "feature_disabled";

// A daily refusal knows when its budget resets. An action period refusal
// names its window's reset; the MCP read fence's window refusal does not. No
// other refusal may claim one. Only a disabled feature names its kill switch.
type ActionAdmissionErrorProps = { message: string; cause?: unknown } & (
  | { reason: "daily_exhausted"; retryAtMs: number; killSwitch?: never }
  | { reason: "period_exhausted"; retryAtMs?: number; killSwitch?: never }
  | { reason: "feature_disabled"; killSwitch: KillSwitchId; retryAtMs?: never }
  | {
      reason: Exclude<
        ActionAdmissionReason,
        "daily_exhausted" | "period_exhausted" | "feature_disabled"
      >;
      retryAtMs?: never;
      killSwitch?: never;
    }
);

// TaggedError cannot take a union of props, so the constructor binds
// `retryAtMs` to the exhausted reasons and the base keeps the shared fields.
export class ActionAdmissionError extends TaggedError("ActionAdmissionError")<{
  message: string;
  reason: ActionAdmissionReason;
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }

  /** Epoch milliseconds at which an exhausted budget resets. */
  readonly retryAtMs: number | undefined;
  /** The switch that turned the refused feature off. */
  readonly killSwitch: KillSwitchId | undefined;

  constructor({ retryAtMs, killSwitch, ...props }: ActionAdmissionErrorProps) {
    super(props);
    this.retryAtMs = retryAtMs;
    this.killSwitch = killSwitch;
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
  feature_disabled: ACTION_ADMISSION_CODES.featureDisabled,
} as const satisfies Record<
  ActionAdmissionError["reason"],
  ActionAdmissionCode
>;

type RefusalHintOptions = {
  error: ActionAdmissionError;
  hint: string;
  contactUrl: string | undefined;
};

// A disabled feature's hint names what is off; a budget refusal's hint names
// whom to contact.
const refusalHint = ({ error, hint, contactUrl }: RefusalHintOptions) => {
  if (error.killSwitch !== undefined) {
    return KILL_SWITCHES[error.killSwitch].offHint;
  }
  return contactUrl === undefined ? hint : `${hint} Contact: ${contactUrl}`;
};

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
    hint: refusalHint({ error, hint: refusal.hint, contactUrl }),
    ...(contactUrl === undefined ? {} : { contactUrl }),
  };
};
