import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";

/** A refusal for any reason; a daily refusal resets at a fixed instant. */
export const actionAdmissionErrorFor = (
  reason: ActionAdmissionError["reason"],
  message: string,
) =>
  reason === "daily_exhausted"
    ? new ActionAdmissionError({ reason, message, retryAtMs: 0 })
    : new ActionAdmissionError({ reason, message });
