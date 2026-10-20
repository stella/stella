import { describe, expect, test } from "bun:test";

import { QUERY_ERROR_OUTPUT_FIELDS } from "../../packages/errors/src/query-field-policy.ts";
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
  test("reports normalized query field names from the shared policy", async () => {
    const keys = QUERY_ERROR_OUTPUT_FIELDS.flatMap((field) => {
      const separated = field.replace(/([a-z])(?=[a-z])/gu, "$1_");
      return [
        field,
        field.toUpperCase(),
        separated,
        `database.${separated.toUpperCase()}`,
      ];
    });
    const source = keys
      .map(
        (key) => `logger.info("query.failed", { ${JSON.stringify(key)}: 1 });`,
      )
      .join("\n");
    expect(
      await lintSingleRule("no-redacted-log-attribute-key", source),
    ).toEqual(keys.map((_, index) => index + 1));
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
