import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (...lines: readonly string[]) =>
  await lintSingleRule("require-fetch-after-all", lines.join("\n"), {
    plugin: "bun-test-hygiene",
    sourcePath: "suite.test.ts",
  });

describe("beforeAll fetch replacement cleanup", () => {
  test("accepts a paired afterAll restore", async () => {
    expect(
      await lint(
        'import { afterAll, beforeAll, describe } from "bun:test";',
        'describe("paired", () => {',
        "  const originalFetch = globalThis.fetch;",
        "  beforeAll(() => { globalThis.fetch = replacement; });",
        "  afterAll(() => { globalThis.fetch = originalFetch; });",
        "});",
      ),
    ).toEqual([]);
  });

  test("reports a missing restore", async () => {
    expect(
      await lint(
        'import { beforeAll, describe } from "bun:test";',
        'describe("leaking", () => {',
        "  beforeAll(() => { globalThis.fetch = replacement; });",
        "});",
      ),
    ).toEqual([3]);
  });

  test("reports a bracket-form replacement without a restore", async () => {
    expect(
      await lint(
        'import { beforeAll, describe } from "bun:test";',
        'describe("leaking", () => {',
        '  beforeAll(() => { globalThis["fetch"] = replacement; });',
        "});",
      ),
    ).toEqual([3]);
  });

  test("does not accept a restore in a sibling describe", async () => {
    expect(
      await lint(
        'import { afterAll, beforeAll, describe } from "bun:test";',
        'describe("leaking", () => {',
        "  beforeAll(() => { globalThis.fetch = replacement; });",
        "});",
        'describe("sibling", () => {',
        "  afterAll(() => { globalThis.fetch = originalFetch; });",
        "});",
      ),
    ).toEqual([3]);
  });
});
