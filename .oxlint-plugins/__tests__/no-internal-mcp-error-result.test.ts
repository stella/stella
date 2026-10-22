import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(
      `fixtures/no-internal-mcp-error-result.${name}.ts`,
      import.meta.url,
    ),
    "utf-8",
  );

describe("no-internal-mcp-error-result", () => {
  test("reports internal error message member chains", async () => {
    expect(
      await lintSingleRule("no-internal-mcp-error-result", fixture("invalid")),
    ).toEqual([8, 9, 10, 11, 12]);
  });

  test("allows public refusal text and internalFailureResult", async () => {
    expect(
      await lintSingleRule("no-internal-mcp-error-result", fixture("valid")),
    ).toEqual([]);
  });
});
