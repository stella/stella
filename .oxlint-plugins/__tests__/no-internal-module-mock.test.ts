import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-internal-module-mock", () => {
  test("reports relative and workspace mocks through an alias", async () => {
    expect(
      await lintSingleRule(
        "no-internal-module-mock",
        'import { mock as fake } from "bun:test";\nfake.module("./dependency", () => ({}));\nfake.module("@stll/files", () => ({}));',
      ),
    ).toEqual([2, 3]);
  });
  test("reports namespace mocks with unresolvable targets", async () => {
    expect(
      await lintSingleRule(
        "no-internal-module-mock",
        'import * as test from "bun:test";\ntest.mock.module(target, factory);',
      ),
    ).toEqual([2]);
  });
  test("reports engine and adapter packages despite npm scope", async () => {
    expect(
      await lintSingleRule(
        "no-internal-module-mock",
        'import { mock } from "bun:test";\nmock.module("@tanstack/ai", factory);\nmock.module("@tanstack/ai-openai", factory);',
      ),
    ).toEqual([2, 3]);
  });
  test("accepts external boundary and builtin mocks", async () => {
    expect(
      await lintSingleRule(
        "no-internal-module-mock",
        'import { mock } from "bun:test";\nmock.module("@aws-sdk/client-s3", factory);\nmock.module("node:fs", factory);\nmock.module("bun:sqlite", factory);',
      ),
    ).toEqual([]);
  });
  test("does not mistake unrelated module helpers for Bun mocks", async () => {
    expect(
      await lintSingleRule(
        "no-internal-module-mock",
        'import { mock } from "other-library";\nmock.module("./dependency", factory);',
      ),
    ).toEqual([]);
  });
});
