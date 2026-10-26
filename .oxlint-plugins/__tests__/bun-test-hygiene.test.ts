import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const plugin = "bun-test-hygiene";
const rule = "require-module-mock-reset";

test("requires a file-level restore for module mocks", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, describe, mock, spyOn } from "bun:test";',
        "const first = mock(() => 1);",
        'mock.module("dependency", () => ({}));',
        'spyOn(console, "log");',
        'describe("suite", () => { beforeEach(() => mock.restore()); });',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([2, 3, 4]);
});

test("accepts restore and default reinstallation in one file-level hook", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { afterEach as cleanup, mock as mockFn } from "bun:test";',
        "const dependency = mockFn(() => 1);",
        "cleanup(() => {",
        "  mockFn.restore();",
        "  dependency.mockReset();",
        "  dependency.mockImplementation(() => 1);",
        "});",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("does not treat clearAllMocks as an implementation reset", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock } from "bun:test";',
        "const dependency = mock(() => 1);",
        "beforeEach(() => mock.clearAllMocks());",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([2]);
});

test("ignores mocks created inside tests and helper callbacks", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { mock, test } from "bun:test";',
        "const makeMock = () => mock();",
        'test("local", () => { mock(); });',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});
