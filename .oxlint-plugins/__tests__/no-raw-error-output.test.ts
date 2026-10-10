import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects caught errors and stable aliases passed to process output sinks", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `try { await work(); } catch (caught) {
  const failure = caught;
  console.error(failure);
  process.stderr.write(String(caught));
  process.stdout.write(\`failed: \${failure.message}\`);
  Bun.write(Bun.stderr, caught.stack);
  Bun.write(Bun.stdout, { cause: caught.cause });
}`,
    ),
  ).toEqual([3, 4, 5, 6, 7]);
});

test("rejects error and cause identifiers, including Result.error members", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `console.error(error);
console.warn(err.message);
process.stderr.write(cause);
console.log(result.error);
console.log(result.error.message);`,
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("rejects arbitrary promise catch callback bindings", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `work().catch((failure) => console.error(failure));
work().catch((reason) => process.stderr.write(String(reason)));`,
    ),
  ).toEqual([1, 2]);
});

test("recognizes imported sanitizer and printer aliases", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `import { sanitizeErrorForOutput as redact, printError as report, logErrorOutput as log, sanitizeErrorAttributesForOutput as attributes,} from "@stll/errors";
import { runScriptWithErrorOutput as run } from "@stll/errors/script-error";
const safe = redact(error);
logger.error("fixture.failed", attributes({ cause: error }));
console.error(safe);
report(error);
log({ level: "error", values: [error] });
await run(async () => { throw error; });`,
    ),
  ).toEqual([]);
});

test("requires the shared logger for every imported betterAuth factory", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `import { betterAuth as createAuth } from "better-auth";
import { errorOutputLogger as sharedLogger } from "@stll/errors";
createAuth({});
createAuth({ logger: console });
createAuth({ logger: sharedLogger });
createAuth({ ...options, logger: sharedLogger });
createAuth({ logger: sharedLogger, ...options });
createAuth({ logger: sharedLogger, ...options, logger: console });
createAuth({ ...options, logger: sharedLogger, ...overrides });
createAuth({ logger: sharedLogger, [key]: otherLogger });
createAuth({ logger: sharedLogger, logger: console });
createAuth({ logger: console, logger: sharedLogger });
createAuth({ ...options, ["logger"]: sharedLogger });`,
    ),
  ).toEqual([3, 4, 7, 8, 9, 10, 11]);
});

test("accepts safe formatter output and benign local error text", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `import { formatBetterAuthScriptFailure } from "@/api/scripts/better-auth-script-failure";
const error: string = "request failed";
const emitText = (error: string) => console.error(error);
console.error(error);
process.stderr.write(formatBetterAuthScriptFailure({ cause: caught, code: "failed", message: "failed" }));
process.stderr.write("failed: " + type);`,
    ),
  ).toEqual([]);
});

test("traces stable aliases of process stream sinks", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `const stderr = process.stderr.write;
const report = console.error;
stderr(String(error));
report(error);`,
    ),
  ).toEqual([3, 4]);
});

test("rejects raw error fields sent to logger sinks", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `logger.error("failed", { error });
const warn = logger.warn;
warn("failed", { detail: cause.message });`,
    ),
  ).toEqual([1, 3]);
});

test("accepts error projections from their owning API formatter", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `import { errorSystemFields as project } from "@/api/lib/errors/utils";
logger.error("failed", project(error));`,
    ),
  ).toEqual([]);
});

test("does not treat local strings or shadowed console objects as process errors", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `const console = { error: (value: string) => value };
const error: string = "request failed";
console.error(error);`,
    ),
  ).toEqual([]);
});

test("rejects Error construction and error inspection before printing", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `import { DrizzleQueryError as QueryFailure } from "drizzle-orm";
console.error(new QueryFailure(query, params, cause));
console.error(error.toString());
console.error(Error("failed"));`,
    ),
  ).toEqual([2, 3, 4]);
});

test("rejects errors through transparent TypeScript expression wrappers", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `console.error((error as Error)!);
console.error(<Error>error);
console.error(error satisfies Error);
console.error(identity<Error>(error));
console.error((error as Error).cause);`,
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("covers console inspection methods without treating them as logger methods", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-output",
      `console.dir(error);
console.dirxml(error);
console.trace(error);
console.table(error);
console.assert(false, error);
console.group(error);
console.groupCollapsed(error);
console.timeLog("timer", error);
logger.dir(error);
logger.table(error);`,
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});
