import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

type TaskOption = "priority" | "status";

/** Report an invalid task option without sending its untrusted value. */
export const captureInvalidTaskOption = (option: TaskOption) => {
  getAnalytics().captureError(
    new ClientTelemetryError({
      area: "task-option-rendering",
      message: `[Task option rendering] Invalid ${option}`,
    }),
  );
};
