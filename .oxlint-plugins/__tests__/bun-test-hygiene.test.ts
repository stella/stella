import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const plugin = "bun-test-hygiene";
const rule = "require-module-mock-reset";

test("reports the first test without a named reset", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock, test } from "bun:test";',
        "const dependency = mock(() => 1);",
        "beforeEach(() => mock.restore());",
        'test("uncovered", () => {});',
        'test("also uncovered", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([4]);
});

test("accepts a named reset and default reinstallation", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { afterEach as cleanup, mock as mockFn, test } from "bun:test";',
        "const dependency = mockFn(() => 1);",
        "cleanup(() => {",
        "  dependency.mockReset();",
        "  dependency.mockImplementation(() => 1);",
        "});",
        'test("covered", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("reports reset alone for a mock with a default implementation", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock, test } from "bun:test";',
        "const dependency = mock(() => 1);",
        "beforeEach(() => {",
        "  dependency.mockReset();",
        "});",
        'test("covered", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([6]);
});

test("accepts clear when nothing overrides the implementation", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock, test } from "bun:test";',
        "const dependency = mock(() => 1);",
        "beforeEach(() => dependency.mockClear());",
        'test("covered", () => dependency());',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("reports clear when a test overrides the implementation", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock, test } from "bun:test";',
        "const dependency = mock(() => 1);",
        "beforeEach(() => dependency.mockClear());",
        'test("uncovered", () => dependency.mockReturnValue(2));',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([4]);
});

test("reports a sibling describe not covered by another describe reset", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, describe, mock, test } from "bun:test";',
        "const dependency = mock();",
        'describe("covered", () => {',
        "  beforeEach(() => dependency.mockReset());",
        '  test("first", () => {});',
        "});",
        'describe("sibling", () => {',
        '  test("reported", () => {});',
        "});",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([8]);
});

test("inherits a parent describe reset in a nested describe", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, describe, mock, test } from "bun:test";',
        "const dependency = mock();",
        'describe("parent", () => {',
        "  beforeEach(() => dependency.mockReset());",
        '  describe("nested", () => {',
        '    test("covered", () => {});',
        "  });",
        "});",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("reports a module-scope spy", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock, spyOn, test } from "bun:test";',
        'spyOn(console, "log");',
        "beforeEach(() => mock.clearAllMocks());",
        'test("uncovered", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([2]);
});

test("accepts a spy created in beforeEach and restored in afterEach", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { afterEach, beforeEach, mock, spyOn, test } from "bun:test";',
        'beforeEach(() => spyOn(console, "log"));',
        "afterEach(() => mock.restore());",
        'test("covered", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("reports a spy when restore is in beforeEach", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { beforeEach, mock, spyOn, test } from "bun:test";',
        'beforeEach(() => spyOn(console, "log"));',
        "beforeEach(() => mock.restore());",
        'test("uncovered", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([2]);
});

test("inherits a parent describe afterEach for a nested spy", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { afterEach, beforeEach, describe, mock, spyOn, test } from "bun:test";',
        'describe("parent", () => {',
        "  afterEach(() => mock.restore());",
        '  describe("nested", () => {',
        '    beforeEach(() => spyOn(console, "log"));',
        '    test("covered", () => {});',
        "  });",
        "});",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
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
