import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw error attributes across structured logger sinks", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-logging",
      'logger.warn("failed", { error });\nlogger.error("failed", { "error.message": error.message });\nlogger.info("failed", { reason: String(error) });\nlogger.debug("failed", { cause });',
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects raw errors in both Bun streams and process stderr", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-logging",
      `process.stderr.write(\`failure: \${error.message}\`);
Bun.write(Bun.stderr, error.stack);
Bun.write(Bun.stdout, String(error));`,
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects the legacy raw-message field outside its owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-logging",
      'fields["error.msg"] = message;',
      { sourcePath: "apps/api/src/lib/worker.ts", cwd: "scratch" },
    ),
  ).toEqual([1]);
});

test("accepts structural evidence and non-error stream metadata", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-logging",
      `observeFailure(error, { sink: failed });
logger.warn("failed", { "message.bytes": message.length });
logger.error("failed", { ...errorFields(readEvidence(error)) });
process.stderr.write(\`failure: \${type}\`);`,
    ),
  ).toEqual([]);
});

test("allows the legacy raw-message key in its exact owner and test sources", async () => {
  for (const sourcePath of [
    "apps/api/src/lib/errors/utils.ts",
    "apps/api/src/worker.test.ts",
  ]) {
    expect(
      await lintSingleRule(
        "no-raw-error-logging",
        'fields["error.msg"] = message;',
        { sourcePath, cwd: "scratch" },
      ),
    ).toEqual([]);
  }
});

test("does not exempt a utils basename from another directory", async () => {
  expect(
    await lintSingleRule(
      "no-raw-error-logging",
      'fields["error.msg"] = message;',
      { sourcePath: "apps/api/src/other/utils.ts", cwd: "scratch" },
    ),
  ).toEqual([1]);
});
