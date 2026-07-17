// The top-level error boundary for the CLI shell. `main()` performs unguarded
// startup I/O (config/credential reads, cache refresh); without a boundary an
// unexpected throw escapes as an unhandled promise rejection with a raw stack
// and a default exit code, bypassing the CLI's exit-code contract (spec 051
// S4). This maps any such error to a one-line stderr message and the generic
// `unexpected` (1) exit class. Command-level failures already set their own
// exit codes upstream; this catches only what escapes that path.

import { EXIT_CODES } from "./mcp-constants.js";

/** The minimal process surface the boundary writes to. */
export type FatalErrorReporter = {
  stderr: { write: (text: string) => void };
  exitCode?: number | string | null | undefined;
};

export const reportFatalError = (
  error: unknown,
  reporter: FatalErrorReporter,
): void => {
  const message = error instanceof Error ? error.message : String(error);
  reporter.stderr.write(`stella: ${message}\n`);
  reporter.exitCode = EXIT_CODES.unexpected;
};
