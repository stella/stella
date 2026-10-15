import { Result } from "better-result";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const RESPONSE_CONFORMANCE_BATCH_DIRECTORY =
  "RESPONSE_CONFORMANCE_BATCH_DIRECTORY";

export type ResponseConformanceExecution = {
  kind: "http" | "handler-context" | "mcp";
  identity: string;
};

const observations = new Map<string, ResponseConformanceExecution>();
let directory: string | undefined;

/** Parent runner accepts this process-local journal only after a successful batch. */
export const initializeResponseConformanceExecutionCollection = (): void => {
  if (directory !== undefined) {
    return;
  }
  directory = process.env[RESPONSE_CONFORMANCE_BATCH_DIRECTORY];
  if (directory === undefined) {
    return;
  }
  const output = path.join(
    directory,
    `${process.pid}-${Bun.randomUUIDv7()}.json`,
  );
  process.once("exit", () => {
    const written = Result.try(() =>
      writeFileSync(
        output,
        JSON.stringify({
          version: 1,
          observations: [...observations.values()],
        }),
      ),
    );
    if (written.isErr()) {
      process.stderr.write(
        `Could not write response conformance journal: ${written.error.message}\n`,
      );
    }
  });
};

/** Records templates/tool names only; request URLs and response values never enter the journal. */
export const recordResponseConformanceExecution = (
  kind: ResponseConformanceExecution["kind"],
  identity: string,
): void => {
  if (directory === undefined) {
    return;
  }
  const key = JSON.stringify([kind, identity]);
  observations.set(key, { kind, identity });
};
