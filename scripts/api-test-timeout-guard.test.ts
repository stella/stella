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

  test("rejects every deadline it cannot prove long", () => {
    for (const source of [
      "const SETTLE_MS = 500;\nrequest({ timeoutMs: SETTLE_MS * 2 });",
      "const SETTLE_MS = 5_000;\nrequest({ timeoutMs: SETTLE_MS * 2 });",
      "const timeoutMs = 500;\nrequest({ timeoutMs });",
      'import { SETTLE_MS } from "./timeouts";\nrequest({ timeoutMs: SETTLE_MS });',
      "request({ timeoutMs: slow ? 5_000 : 500 });",
      "let SETTLE_MS = 5_000;\nrequest({ timeoutMs: SETTLE_MS });",
      "request({ timeoutMs: options.timeoutMs });",
      "request({ timeoutMs: HAPPY_PATH_TIMEOUT_MS / 100 });",
      'request({ "timeoutMs": 500 });',
    ]) {
      expect(findApiTestTimeoutViolations(source), source).toHaveLength(1);
    }
  });

  test("an unproven value passes only with a reasoned marker", () => {
    expect(
      findApiTestTimeoutViolations(
        "request({ timeoutMs: options.timeoutMs }); // timeout: forwarded from the caller",
      ),
    ).toEqual([]);
    expect(
      findApiTestTimeoutViolations(
        "request({ timeoutMs: options.timeoutMs }); // timeout:",
      ),
    ).toHaveLength(1);
  });

  test("accepts provably long deadlines through const chains and shorthand", () => {
    for (const source of [
      "const timeoutMs = 5_000;\nrequest({ timeoutMs });",
      "const BASE = 5_000 as const;\nconst SETTLE_MS = BASE;\nrequest({ timeoutMs: SETTLE_MS });",
      "request({ timeoutMs: (HAPPY_PATH_TIMEOUT_MS) });",
      "type Options = { timeoutMs: number };",
    ]) {
      expect(findApiTestTimeoutViolations(source), source).toEqual([]);
    }
  });
});
