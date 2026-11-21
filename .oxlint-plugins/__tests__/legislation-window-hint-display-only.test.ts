import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects property reads computed keys and destructured hints", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-hint-display-only",
      'row.windowHintNextStart;\nrow["windowHintNextStart"];\nconst { windowHintNextStart: next } = row;',
      { plugin: "legislation-window" },
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects raw SQL and template spellings of publisher hints", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-hint-display-only",
      'sql.raw("window_hint_next_start");\nsql`SELECT window_hint_next_start FROM versions`;',
      { plugin: "legislation-window" },
    ),
  ).toEqual([1, 2]);
});

test("rejects renamed imports of the hint capability", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-hint-display-only",
      'import { windowHintNextStart as next } from "./projection";',
      { plugin: "legislation-window" },
    ),
  ).toEqual([1]);
});

test("accepts authoritative window properties and unrelated hints", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-hint-display-only",
      "row.versionValidFrom;\nrow.windowDisposition;\nrow.nextStartLabel;\nsql`SELECT version_valid_to FROM versions`;",
      { plugin: "legislation-window" },
    ),
  ).toEqual([]);
});
