/**
 * Elysia reports every schema violation as `code === "VALIDATION"`, but a
 * failure on the `response` target means the handler produced output that
 * breaks its own contract: a server defect answered with a client status.
 * Sinks that grade validation as a client fault must exempt it.
 */
export const isResponseValidationError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "type" in error &&
  error.type === "response";
