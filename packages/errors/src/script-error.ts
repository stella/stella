import { Result } from "better-result";
import process from "node:process";

import { printError } from "./query-error";

/** A script that failed in any way exits with this code, never 0. */
export const SCRIPT_FAILURE_EXIT_CODE = 1;

const failScript = (error: unknown): never => {
  printError(error);
  return process.exit(SCRIPT_FAILURE_EXIT_CODE);
};

/**
 * Catch a script entrypoint before the runtime prints a raw rejection.
 *
 * Fail closed on every failure, not only the one `run` rejects with. Bun
 * prints a rejection nothing awaits (or an exception thrown from a timer or
 * a socket callback) and keeps running, so a script whose entry then ends
 * with `process.exit(0)` would report success after a failure it never saw.
 * Such a failure ends the process at once with a non-zero code.
 */
export const runScriptWithErrorOutput = async (
  run: () => Promise<void>,
): Promise<void> => {
  process.on("unhandledRejection", failScript);
  process.on("uncaughtException", failScript);
  const result = await Result.tryPromise(run);
  if (result.isErr()) {
    failScript(result.error);
  }
};
