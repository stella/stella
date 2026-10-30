import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const plugin = "bun-test-hygiene";
const rule = "no-wait-for-under-fake-timers";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule(rule, lines.join("\n"), { plugin });

test("reports retrying Testing Library calls after fake timers", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("race", async () => {',
      "  jest.useFakeTimers();",
      "  await waitFor(() => true);",
      '  await view.findByRole("button");',
      "  await waitForElementToBeRemoved(node);",
      "});",
    ]),
  ).toEqual([4, 5, 6]);
});

test("reports waits covered by a fake-timer beforeEach", async () => {
  expect(
    await lint([
      'import { beforeEach, jest, test } from "bun:test";',
      "beforeEach(() => jest.useFakeTimers());",
      'test("race", async () => {',
      "  await testing.waitFor(() => true);",
      "});",
    ]),
  ).toEqual([4]);
});

test("accepts synchronous assertions after explicitly driving the clock", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("driven", async () => {',
      "  jest.useFakeTimers();",
      "  await act(async () => jest.advanceTimersByTime(50));",
      '  expect(view.getByRole("button")).toBeDefined();',
      "});",
    ]),
  ).toEqual([]);
});

test("accepts a wait after real timers are restored", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("real again", async () => {',
      "  jest.useFakeTimers();",
      "  restoreRealTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([]);
});

test("does not apply a sibling suite's beforeEach", async () => {
  expect(
    await lint([
      'import { beforeEach, describe, jest, test } from "bun:test";',
      'describe("fake", () => {',
      "  beforeEach(() => jest.useFakeTimers());",
      '  test("driven", () => expect(true).toBe(true));',
      "});",
      'describe("real", () => {',
      '  test("waits", async () => {',
      "    await waitFor(() => true);",
      "  });",
      "});",
    ]),
  ).toEqual([]);
});
