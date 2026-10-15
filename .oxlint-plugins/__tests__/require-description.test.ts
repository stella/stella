import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects bare line and block disable directives", async () => {
  expect(
    await lintSingleRule(
      "require-description",
      '// oxlint-disable-next-line no-console\nconsole.log("cli");\n/* oxlint-disable no-debugger */\nconst x = 1;',
      { plugin: "suppression-hygiene" },
    ),
  ).toEqual([1, 3]);
});

test("rejects empty inline rationale", async () => {
  expect(
    await lintSingleRule(
      "require-description",
      '// oxlint-disable-next-line no-console --   \nconsole.log("cli");',
      { plugin: "suppression-hygiene" },
    ),
  ).toEqual([1]);
});

test("accepts a nonempty inline explanation", async () => {
  expect(
    await lintSingleRule(
      "require-description",
      '// oxlint-disable-next-line no-console -- development CLI output\nconsole.log("cli");',
      { plugin: "suppression-hygiene" },
    ),
  ).toEqual([]);
});

test("accepts an adjacent preceding rationale", async () => {
  expect(
    await lintSingleRule(
      "require-description",
      '// SAFETY: the CLI deliberately prints its result.\n// oxlint-disable-next-line no-console\nconsole.log("cli");',
      { plugin: "suppression-hygiene" },
    ),
  ).toEqual([]);
});

test("does not borrow a rationale across a blank line or another directive", async () => {
  expect(
    await lintSingleRule(
      "require-description",
      '// This explanation belongs to an earlier statement.\n\n// oxlint-disable-next-line no-console\nconsole.log("cli");\n// oxlint-enable no-console\n// oxlint-disable-next-line no-console\nconsole.log("cli");',
      { plugin: "suppression-hygiene" },
    ),
  ).toEqual([3, 6]);
});

test("accepts normal prose and enable directives", async () => {
  expect(
    await lintSingleRule(
      "require-description",
      "// A normal development note.\n// oxlint-enable no-console\nconst x = 1;",
      { plugin: "suppression-hygiene" },
    ),
  ).toEqual([]);
});
