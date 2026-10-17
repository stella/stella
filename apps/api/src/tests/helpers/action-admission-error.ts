import { panic } from "better-result";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";

/**
 * A refusal for any reason; a daily refusal resets at a fixed instant and a
 * disabled feature names the chat switch.
 */
export const actionAdmissionErrorFor = (
  reason: ActionAdmissionError["reason"],
  message: string,
) => {
  switch (reason) {
    case "daily_exhausted":
      return new ActionAdmissionError({ reason, message, retryAtMs: 0 });
    case "feature_disabled":
      return new ActionAdmissionError({ reason, message, killSwitch: "chat" });
    case "busy":
    case "period_exhausted":
    case "not_enabled":
    case "not_on_plan":
    case "unavailable":
      return new ActionAdmissionError({ reason, message });
    default:
      reason satisfies never;
      return panic(`Unknown admission reason: ${String(reason)}`);
  }
};
