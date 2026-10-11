import { Result } from "better-result";
import process from "node:process";

import { printError } from "./query-error";

/** Catch a script entrypoint before the runtime prints a raw rejection. */
export const runScriptWithErrorOutput = async (
  run: () => Promise<void>,
): Promise<void> => {
  const result = await Result.tryPromise(run);
  if (result.isErr()) {
    printError(result.error);
    process.exit(1);
  }
};
