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

test("reports a spy created in a test that nothing restores", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { spyOn, test } from "bun:test";',
        'test("leaks", () => spyOn(console, "log"));',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([2]);
});

test("accepts a spy created in a test and restored in afterEach", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { afterEach, mock, spyOn, test } from "bun:test";',
        "afterEach(() => mock.restore());",
        'test("restored", () => spyOn(console, "log"));',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("accepts a test that restores its own spy in finally", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { spyOn, test } from "bun:test";',
        'test("restores", () => {',
        '  const log = spyOn(console, "log").mockImplementation(() => {});',
        "  try {",
        "    console.log(1);",
        "  } finally {",
        "    log.mockRestore();",
        "  }",
        "});",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("reports a test whose own restore skips failures or another spy", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { spyOn, test } from "bun:test";',
        'test("restores only on success", () => {',
        '  const log = spyOn(console, "log");',
        "  log.mockRestore();",
        "});",
        'test("restores another spy", () => {',
        '  const warn = spyOn(console, "warn");',
        '  const log = spyOn(console, "log");',
        "  try {",
        "    console.log(1);",
        "  } finally {",
        "    log.mockRestore();",
        "  }",
        "});",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([3, 7]);
});

test("reports a reset and a reinstall split across two hooks", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { afterEach, beforeEach, mock, test } from "bun:test";',
        "const dependency = mock(() => 1);",
        "beforeEach(() => dependency.mockReset());",
        "afterEach(() => dependency.mockImplementation(() => 1));",
        'test("starts without its default", () => {});',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([5]);
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
