import {
  errorSystemFields,
  safeErrorTelemetryFields,
} from "@/api/lib/errors/utils";

/**
 * Safe log fields for a failed document-processing attempt.
 *
 * `errorTag` alone names the class, and every extraction failure shares one
 * class, so the tag cannot tell a parser rejection from a timeout, a crash,
 * or an external kill: the run is unactionable from the log. Both helpers
 * here are the sanctioned non-content sinks, and `captureError` already
 * pairs them on the analytics path, so this only stops the log sink from
 * being the poorer of the two.
 *
 * `errorSystemFields` carries the `code` discriminator (plus a wrapped
 * cause's class and code); `safeErrorTelemetryFields` adds the extraction
 * shape the code alone does not give: mime type, size, and either the
 * termination reason and signal or the exit code.
 */
export const documentProcessingFailureFields = (
  error: unknown,
): Record<string, string> => ({
  ...errorSystemFields(error),
  ...safeErrorTelemetryFields(error),
});
