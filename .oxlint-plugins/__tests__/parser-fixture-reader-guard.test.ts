import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

/** A fixture test beside the parsers, so `./sk-us` is the parser module. */
const PARSER_TEST = {
  sourcePath: "apps/api/src/handlers/case-law/ingestion/parsers/sk-us.test.ts",
};

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
      PARSER_TEST,
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
      PARSER_TEST,
    ),
  ).toEqual([3, 4]);
});

test("allows parser fixtures routed through the imported reader schema guard", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import { guardParser } from "@/api/tests/helpers/parser-reader-guard";',
        'import { parseSkUsDocumentXhtml as rawParse } from "./sk-us";',
        "const parse = guardParser(rawParse);",
        "parse(input);",
      ].join("\n"),
      PARSER_TEST,
    ),
  ).toEqual([]);
});

test("a stub module exporting a parser's name is not the parser", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import { parseSkUsDocumentXhtml } from "@/api/tests/helpers/fake-parsers";',
        'import * as fake from "@/api/tests/helpers/fake-parsers";',
        "parseSkUsDocumentXhtml(input);",
        "fake.parseSkUsDocumentXhtml(input);",
      ].join("\n"),
      PARSER_TEST,
    ),
  ).toEqual([]);
});

test("the parser module is recognised by its alias path too", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import { parseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";',
        "parseSkUsDocumentXhtml(input);",
      ].join("\n"),
    ),
  ).toEqual([2]);
});

test("a computed key on a parser namespace counts unless it is a string literal", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import * as parser from "./sk-us";',
        'const key = "parseSkUsDocumentXhtml";',
        "parser[key](input);",
        'parser["parseSkUsDocumentXhtml"](input);',
        'parser["notAParser"](input);',
      ].join("\n"),
      PARSER_TEST,
    ),
  ).toEqual([3, 4]);
});

test("a local binding that shadows a parser's name is not the parser", async () => {
  expect(
    await lintSingleRule(
      "parser-fixture-reader-guard",
      [
        'import { guardParser } from "@/api/tests/helpers/parser-reader-guard";',
        'import { parseSkUsDocumentXhtml } from "./sk-us";',
        "const parse = guardParser(parseSkUsDocumentXhtml);",
        "inputs.map((parseSkUsDocumentXhtml) => parseSkUsDocumentXhtml);",
      ].join("\n"),
      PARSER_TEST,
    ),
  ).toEqual([]);
});
