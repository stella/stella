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

test("reports a wait nested in an act callback", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useFakeTimers();",
      "  await act(async () => {",
      "    await waitFor(() => true);",
      "  });",
      "});",
    ]),
  ).toEqual([5]);
});

test("reports a deeply nested wait covered by beforeEach", async () => {
  expect(
    await lint([
      'import { beforeEach, jest, test } from "bun:test";',
      "beforeEach(() => jest.useFakeTimers());",
      'test("unsafe", async () => {',
      "  await act(async () => {",
      "    await helper(async () => {",
      "      await waitFor(() => true);",
      "    });",
      "  });",
      "});",
    ]),
  ).toEqual([6]);
});

test("accepts a nested wait after a direct test-body restoration", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("safe", async () => {',
      "  jest.useFakeTimers();",
      "  jest.useRealTimers();",
      "  await act(async () => {",
      "    await waitFor(() => true);",
      "  });",
      "});",
    ]),
  ).toEqual([]);
});

test("ignores a nested restoration before a nested wait", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useFakeTimers();",
      "  await act(async () => {",
      "    jest.useRealTimers();",
      "    await waitFor(() => true);",
      "  });",
      "});",
    ]),
  ).toEqual([6]);
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

test("resolves an aliased fake-timer hook", async () => {
  expect(
    await lint([
      'import { beforeEach as setup, jest, test } from "bun:test";',
      "setup(() => jest.useFakeTimers());",
      'test("unsafe", async () => {',
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([4]);
});

test("resolves a namespace-imported fake-timer hook", async () => {
  expect(
    await lint([
      'import * as t from "vitest";',
      "t.beforeEach(() => t.vi.useFakeTimers());",
      't.test("unsafe", async () => {',
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([4]);
});

test("ignores fake timers in an uncalled module-level function declaration", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      "function install() { jest.useFakeTimers(); }",
      'test("safe", async () => {',
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([]);
});

test("treats a function declaration inside a test as possibly active", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  function install() { jest.useFakeTimers(); }",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([4]);
});

test("does not treat afterEach restoration as preceding the test", async () => {
  expect(
    await lint([
      'import { afterEach, beforeEach, jest, test } from "bun:test";',
      "beforeEach(() => jest.useFakeTimers());",
      "afterEach(() => jest.useRealTimers());",
      'test("race", async () => {',
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([5]);
});

test("inherits fake timers through nested describe scopes", async () => {
  expect(
    await lint([
      'import { beforeEach, describe, jest, test } from "bun:test";',
      'describe("outer", () => {',
      "  beforeEach(() => jest.useFakeTimers());",
      '  describe("inner", () => {',
      '    test("race", async () => {',
      "      await waitFor(() => true);",
      "    });",
      "  });",
      "});",
    ]),
  ).toEqual([6]);
});

test("uses hook execution order when a later beforeEach restores timers", async () => {
  expect(
    await lint([
      'import { beforeEach, jest, test } from "bun:test";',
      "beforeEach(() => jest.useFakeTimers());",
      "beforeEach(() => jest.useRealTimers());",
      'test("real again", async () => {',
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([]);
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

test("does not let an uncalled nested helper restore real timers", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useFakeTimers();",
      "  const restore = () => jest.useRealTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([5]);
});

test("does not let a conditional branch restore real timers", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useFakeTimers();",
      "  if (condition) jest.useRealTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([5]);
});

test("accepts a direct useRealTimers statement before a wait", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("safe", async () => {',
      "  jest.useFakeTimers();",
      "  jest.useRealTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([]);
});

test("reports when fake timers are reinstalled after a restoration", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useRealTimers();",
      "  jest.useFakeTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([5]);
});

test("reports a conditional fake-timer installation after restoration", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useRealTimers();",
      "  if (condition) jest.useFakeTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([5]);
});

test("reports a looped fake-timer installation after restoration", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useRealTimers();",
      "  for (const item of items) {",
      "    jest.useFakeTimers();",
      "  }",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([7]);
});

test("accepts when restoration is the last timer call before a wait", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("safe", async () => {',
      "  jest.useFakeTimers();",
      "  jest.useRealTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([]);
});

test("reports when fake timers are installed after the wait", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useFakeTimers();",
      "  jest.useRealTimers();",
      "  await waitFor(() => true);",
      "  jest.useFakeTimers();",
      "});",
    ]),
  ).toEqual([5]);
});

test("reports when a nested helper may reinstall timers after restoration", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  jest.useRealTimers();",
      "  const install = () => jest.useFakeTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([5]);
});

test("treats fake timers in a nested helper as possibly active", async () => {
  expect(
    await lint([
      'import { jest, test } from "bun:test";',
      'test("unsafe", async () => {',
      "  const install = () => jest.useFakeTimers();",
      "  await waitFor(() => true);",
      "});",
    ]),
  ).toEqual([4]);
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
