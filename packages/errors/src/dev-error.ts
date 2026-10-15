// parser-output-unchanged: This change only redacts query parameters from error output and does not change parser output.
import { sanitizeErrorForOutput } from "./query-error";

// Dev-only error logging, shared by the API and web apps. Both surface
// errors to `console.error` in dev and no-op in prod; the API additionally
// forwards to a JSONL file sink so headless tools can tail errors without
// the dev tty. That divergence is expressed as an injected `sink`, so this
// module never imports `node:fs` and the browser build cannot pull one in.

export type DevErrorSink = (input: {
  error: unknown;
  context?: Record<string, unknown> | undefined;
}) => void;

export type CreateDevErrorLoggerOptions = {
  /** Whether to echo errors at all; the logger no-ops otherwise. */
  echoErrors: boolean;
  /** Optional extra sink (e.g. a JSONL file sink on the server). */
  sink?: DevErrorSink;
};

/**
 * Build a dev-only error logger. In dev it echoes to `console.error` and,
 * when a `sink` is provided, forwards `{ error, context }` to it. A no-op
 * outside dev.
 */
export const createDevErrorLogger =
  ({ echoErrors, sink }: CreateDevErrorLoggerOptions) =>
  (error: unknown, context?: Record<string, unknown>): void => {
    if (!echoErrors) {
      return;
    }
    const safeOutput = sanitizeErrorForOutput({ error, context });
    const safeEnvelope =
      safeOutput !== null &&
      typeof safeOutput === "object" &&
      "error" in safeOutput
        ? safeOutput
        : undefined;
    const safeError =
      safeEnvelope === undefined ? safeOutput : safeEnvelope.error;
    const contextValue =
      safeEnvelope !== undefined && "context" in safeEnvelope
        ? safeEnvelope.context
        : undefined;
    const safeContext =
      contextValue !== null &&
      typeof contextValue === "object" &&
      !Array.isArray(contextValue)
        ? Object.fromEntries(Object.entries(contextValue))
        : undefined;
    // oxlint-disable-next-line no-console -- dev-only error echo
    console.error(safeError);
    sink?.({ error: safeError, context: safeContext });
  };
