import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-local-paragraph-label";

test("rejects a regular expression that reads a printed label at a line start", async () => {
  const source = [
    "/^\\d{1,3}\\.\\s/u.test(text);",
    "/^(?:\\d{1,3}[.)]|\\p{L}\\)|[-–•])\\s/u.test(text);",
    "/^\\[(?<number>\\d{1,4})\\]\\s*/u.exec(text);",
    "/^\\(?\\d{1,3}\\)(?:\\s|$)/u.test(text);",
    "/^\\d{1,3}(?:\\.\\d{1,3})+\\.?\\s/u.test(text);",
    'new RegExp("^(?:\\\\(\\\\d{1,3}\\\\)|\\\\[\\\\d{1,3}\\\\])\\\\s", "u");',
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("accepts the grammar's calls and numbers that open no label", async () => {
  const source = [
    "readPrintedLabel(text);",
    "printedLabelOpensParagraph({ above, line: text });",
    "/^\\d{4}-\\d{2}-\\d{2}$/u.test(text);",
    "/\\d{1,3}\\./u.test(text);",
    "/^[A-Z]{2}\\d+/u.test(text);",
    'new RegExp("\\\\d+", "u");',
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([]);
});
