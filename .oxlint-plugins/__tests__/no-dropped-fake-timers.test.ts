import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "no-dropped-fake-timers";

test("rejects leaving or clearing fake timers through the test runner", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import * as bt from "bun:test";',
        'import { jest, jest as clock } from "bun:test";',
        'import { vi } from "vitest";',
        "jest.useRealTimers();",
        "clock.clearAllTimers();",
        "bt.jest.useRealTimers();",
        "vi.useRealTimers();",
        "jest?.useRealTimers();",
      ].join("\n"),
    ),
  ).toEqual([4, 5, 6, 7, 8]);
});

test("accepts the draining helper and same-named methods on other objects", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import { jest } from "bun:test";',
        'import { restoreRealTimers } from "@stll/property-testing/fake-timers";',
        "const scheduler = { useRealTimers: () => undefined };",
        "restoreRealTimers();",
        "jest.useFakeTimers();",
        "jest.runOnlyPendingTimers();",
        "scheduler.useRealTimers();",
        "page.clock.clearAllTimers();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
