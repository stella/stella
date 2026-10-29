import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("fixture parser imports must go through the reader schema guard", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import { guardParser } from "@/api/tests/helpers/parser-reader-guard";',
        'import { parseSkUsDocumentXhtml as rawParse } from "./sk-us";',
        "rawParse(input);",
        "fixtures.map(rawParse);",
        "const parse = guardParser(rawParse);",
        "parse(input);",
      ].join("\n"),
    ),
  ).toEqual([3, 4]);
});

test("namespace imports and a local function named guardParser cannot bypass the guard", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import * as parser from "./sk-us";',
        "const guardParser = (parse) => parse;",
        "guardParser(parser.parseSkUsDocumentXhtml);",
        "parser.parseSkUsDocumentXhtml(input);",
      ].join("\n"),
    ),
  ).toEqual([3, 4]);
});
