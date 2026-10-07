import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-redacted-log-attribute-key", () => {
  test("reports sensitive logger attribute names", async () => {
    expect(
      await lintSingleRule(
        "no-redacted-log-attribute-key",
        'logger.info("queued", { queueName: "jobs" });',
      ),
    ).toEqual([1]);
  });
  test("reports unreviewed failure correlation keys", async () => {
    expect(
      await lintSingleRule(
        "no-redacted-log-attribute-key",
        'observeFailure(error, { sink: "queue", ctx: { retryCount: 2 } });',
      ),
    ).toEqual([1]);
  });
  test("accepts reviewed correlation and token counts", async () => {
    expect(
      await lintSingleRule(
        "no-redacted-log-attribute-key",
        'logger.info("queued", { queue: "jobs", promptTokens: 4 });\nobserveFailure(error, { sink: "queue", ctx: { jobId, queue: "jobs" } });',
      ),
    ).toEqual([]);
  });
  test("leaves computed and forwarded attributes to their boundary", async () => {
    expect(
      await lintSingleRule(
        "no-redacted-log-attribute-key",
        'logger.info("queued", { [key]: value, ...fields });\nforward("queued", { queueName: "jobs" });',
      ),
    ).toEqual([]);
  });
});
