import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-foreign-directive", () => {
  test("reports dead formatter and lint directives", async () => {
    expect(
      await lintSingleRule(
        "no-foreign-directive",
        "// prettier-ignore\nconst x = 1;\n// biome-ignore lint/style: reason\nconst y = 2;",
        { plugin: "suppression-hygiene" },
      ),
    ).toEqual([1, 3]);
  });
  test("reports legacy disable and enable spellings", async () => {
    expect(
      await lintSingleRule(
        "no-foreign-directive",
        '// eslint-disable-next-line no-console -- CLI\nconsole.log("ready");\n// eslint-enable no-console',
        { plugin: "suppression-hygiene" },
      ),
    ).toEqual([1, 3]);
  });
  test("accepts canonical oxlint directives", async () => {
    expect(
      await lintSingleRule(
        "no-foreign-directive",
        '// oxlint-disable-next-line no-console -- CLI\nconsole.log("ready");',
        { plugin: "suppression-hygiene" },
      ),
    ).toEqual([]);
  });
  test("accepts prose discussing the legacy spelling", async () => {
    expect(
      await lintSingleRule(
        "no-foreign-directive",
        "// Replace eslint-disable comments with the canonical spelling.\nconst x = 1;",
        { plugin: "suppression-hygiene" },
      ),
    ).toEqual([]);
  });
});
