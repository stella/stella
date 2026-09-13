import { describe, expect, test } from "bun:test";

import { sameCliFlagValue } from "./cli-flag-score";

describe("sameCliFlagValue", () => {
  test("treats valid --input JSON with different whitespace and key order as equal", () => {
    expect(
      sameCliFlagValue({
        flagName: "input",
        expected: '{"body":{"mode":"strict","selection":{"type":"previous"}}}',
        actual:
          '{ "body": { "selection": { "type": "previous" }, "mode": "strict" } }',
      }),
    ).toBe(true);
  });

  test("rejects malformed --input JSON", () => {
    expect(
      sameCliFlagValue({
        flagName: "input",
        expected: '{"body":{"mode":"strict"}}',
        actual: '{"body":',
      }),
    ).toBe(false);
  });

  test.each(['{"body":{"mode":"best-effort"}}', "null", "[]", '"input"'])(
    "rejects different or non-object input: %s",
    (actual) => {
      expect(
        sameCliFlagValue({
          flagName: "input",
          expected: '{"body":{"mode":"strict"}}',
          actual,
        }),
      ).toBe(false);
    },
  );

  test("keeps ordinary flag values exact", () => {
    expect(
      sameCliFlagValue({
        flagName: "mode",
        expected: "strict",
        actual: "strict ",
      }),
    ).toBe(false);
  });
});
