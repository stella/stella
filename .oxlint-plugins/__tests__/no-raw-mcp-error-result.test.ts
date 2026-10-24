import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("raw MCP error member spellings require the internal failure envelope", async () => {
  expect(
    await lintSingleRule(
      "no-raw-mcp-error-result",
      `errorResult(error.message);
errorResult(result.error.message);
errorResult(result.error.cause.message);
errorResult(err.details.message);
errorResult(driverError.message);
errorResult(result?.error?.message);
errorResult(cause["message"]);
errorResult(result["error"]["message"]);`,
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("public MCP refusals and structured internal failures remain valid", async () => {
  expect(
    await lintSingleRule(
      "no-raw-mcp-error-result",
      `errorResult("Forbidden");
errorResult(usageRejection.message);
errorResult(validation.message);
internalFailureResult(error);`,
    ),
  ).toEqual([]);
});
