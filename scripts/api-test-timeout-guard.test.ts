import { describe, expect, test } from "bun:test";

import { findApiTestTimeoutViolations } from "./api-test-timeout-guard";

describe("API test timeout guard", () => {
  test("rejects an unmarked short wall-clock timeout", () => {
    expect(
      findApiTestTimeoutViolations("request({ timeoutMs: 1_000 });"),
    ).toHaveLength(1);
  });

  test("accepts a marked deterministic timeout", () => {
    expect(
      findApiTestTimeoutViolations(
        "request({ timeoutMs: 5 }); // timeout under test",
      ),
    ).toEqual([]);
  });

  test("accepts the shared happy-path deadline", () => {
    expect(
      findApiTestTimeoutViolations(
        "request({ timeoutMs: HAPPY_PATH_TIMEOUT_MS });",
      ),
    ).toEqual([]);
  });

  test("judges a local constant by the literal it is bound to", () => {
    expect(
      findApiTestTimeoutViolations(
        "const SETTLE_MS = 500;\nrequest({ timeoutMs: SETTLE_MS });",
      ),
    ).toHaveLength(1);
    expect(
      findApiTestTimeoutViolations(
        "const SETTLE_MS: number = 5_000;\nrequest({ timeoutMs: SETTLE_MS });",
      ),
    ).toEqual([]);
  });

  test("rejects a computed short timeout fail closed", () => {
    expect(
      findApiTestTimeoutViolations("request({ timeoutMs: 500 + 500 });"),
    ).toHaveLength(1);
  });
});
