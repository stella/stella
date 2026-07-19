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
  /** Whether the process is running in dev. Outside dev the logger no-ops. */
  isDev: boolean;
  /** Optional extra sink (e.g. a JSONL file sink on the server). */
  sink?: DevErrorSink;
};

/**
 * Build a dev-only error logger. In dev it echoes to `console.error` and,
 * when a `sink` is provided, forwards `{ error, context }` to it. A no-op
 * outside dev.
 */
export const createDevErrorLogger =
  ({ isDev, sink }: CreateDevErrorLoggerOptions) =>
  (error: unknown, context?: Record<string, unknown>): void => {
    if (!isDev) {
      return;
    }
    // eslint-disable-next-line no-console -- dev-only error echo
    console.error(error);
    sink?.({ error, context });
  };
