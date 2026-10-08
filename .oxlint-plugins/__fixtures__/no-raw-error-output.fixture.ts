import { betterAuth as createAuth } from "better-auth";

import {
  errorOutputLogger as sharedLogger,
  logErrorOutput,
  printError,
} from "@stll/errors";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

declare const runQuery: () => Promise<void>;

// oxlint-disable-next-line no-raw-error-output/no-raw-error-output -- fixture proves SDK logger configuration is required at each factory call
void createAuth({});
void createAuth({ logger: sharedLogger });

const run = async (): Promise<void> => {
  try {
    await runQuery();
  } catch (error) {
    // oxlint-disable-next-line no-raw-error-output/no-raw-error-output -- fixture proves caught errors cannot reach a process sink
    process.stderr.write(String(error));
    printError(error);
    logErrorOutput({ level: "error", values: [error] });
  }
};

// oxlint-disable-next-line no-raw-error-output/no-raw-error-output -- fixture proves arbitrary rejection callback bindings cannot reach logger sinks
void runQuery().catch((error) => logger.error("query.failed", { error }));

declare const logger: {
  error: (event: string, fields: Record<string, unknown>) => void;
};
// expect-clean: no-raw-error-output/no-raw-error-output
void runScriptWithErrorOutput(run);

// oxlint-disable-next-line no-console -- fixture exercises the direct output contract
console.error("query failed");
