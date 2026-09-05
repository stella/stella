// Keeps every exit path on the documented contract (`EXIT_CODES`, rendered by
// the root `--help`). stricli reports its own failures with negative codes
// (unknown command, unparsable flag, loader errors) that the runtime folds
// modulo 256 into 251/252/255, and a command that returns a plain `Error`
// exits 1; neither is a class the contract names. Hand-written commands return
// a `CliCommandError` carrying its class, and the shell normalizes what stricli
// sets itself.

import { ExitCode as StricliExitCode } from "@stricli/core";

import { EXIT_CODES, type ExitCode } from "./mcp-constants.js";

/** An `Error` a hand-written command returns to stricli, tagged with its exit class. */
export class CliCommandError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliCommandError";
    this.exitCode = exitCode;
  }
}

/** stricli's `determineExitCode` hook: a tagged error keeps its class, anything else is unexpected. */
export const determineCommandExitCode = (error: unknown): number =>
  error instanceof CliCommandError ? error.exitCode : EXIT_CODES.unexpected;

const CONTRACT_CODES: ReadonlySet<number> = new Set(Object.values(EXIT_CODES));

/** stricli's negative codes as the runtime stores them after folding modulo 256. */
const folded = (code: number): number => (code < 0 ? code + 256 : code);

const USAGE_CODES: ReadonlySet<number> = new Set(
  [StricliExitCode.UnknownCommand, StricliExitCode.InvalidArgument].flatMap(
    (code) => [code, folded(code)],
  ),
);

/**
 * Map the code stricli left on the process after `run()` onto the contract.
 * Unknown-command and bad-flag failures are usage errors; every other code
 * outside the contract is an unexpected error. Codes commands set themselves
 * pass through untouched.
 */
export const normalizeProcessExitCode = (
  exitCode: number | string | null | undefined,
): number | string | null | undefined => {
  if (typeof exitCode !== "number" || CONTRACT_CODES.has(exitCode)) {
    return exitCode;
  }
  return USAGE_CODES.has(exitCode)
    ? EXIT_CODES.validation
    : EXIT_CODES.unexpected;
};
