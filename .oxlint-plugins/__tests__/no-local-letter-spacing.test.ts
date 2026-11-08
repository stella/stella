import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-local-letter-spacing";

test("rejects a regular expression that joins spaced letters", async () => {
  const source = [
    'text.replace(/(?<=\\p{L}) (?=\\p{L})/gu, "");',
    "/^(?:\\p{L} +)+\\p{L}(?: *[,:;.!?])?$/u.test(text);",
    "/\\p{L}\\p{M}*(?<gap>[  ])(?=\\p{L})/gu.exec(text);",
    'text.replaceAll(/(?<=\\p{L}\\p{M}{0,4}) (?=\\p{Ll})/gu, "");',
    'new RegExp("(?:\\\\p{L} ){3,}\\\\p{L}", "u");',
    'RegExp("(?<=\\\\p{L}) (?=\\\\p{L})", "gu");',
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("accepts the owner's calls and patterns that join no letters", async () => {
  const source = [
    "collapseLetterSpacing(text);",
    "collapseSpacedLetters(text);",
    'text.replace(/(?<=\\p{L}) (?=\\d)|(?<=\\d) (?=\\p{L})/gu, "");',
    "/^(?:\\d{1,3}[.)]|\\p{L}\\)|[-–•])[ \\t]+(?=\\p{L})/u.test(text);",
    "/\\p{L}[\\p{L}\\p{M}]*/gu.test(text);",
    'new RegExp("\\\\s+", "u");',
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([]);
});
