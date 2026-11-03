import { describe, expect, test } from "bun:test";

import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-style-substring-match";
const PARSER = "apps/api/src/handlers/case-law/ingestion/parsers/example.ts";
const VALIDATOR = "apps/api/src/lib/legal-search/parsers/example.ts";
const METHODS = ["includes", "startsWith", "indexOf"] as const;
const OPERATORS = ["*=", "^=", "$=", "~=", "|=", "="] as const;

const hits = [
  ...METHODS.flatMap((method) => [
    `inlineStyle.${method}("font-weight:bold");`,
    `style.${method}("italic");`,
    `$node.attr("style").${method}("-aw-import : ignore");`,
  ]),
  ...OPERATORS.map(
    (operator) => `$("span[style${operator}'font-style:italic']");`,
  ),
];

describe(RULE_NAME, () => {
  test("reports every substring method, receiver shape and selector operator", async () => {
    expect(
      await lintSingleRule(RULE_NAME, hits.join("\n"), { sourcePath: PARSER }),
    ).toEqual(hits.map((_, index) => index + 1));
  });

  test("accepts non-style receivers and non-literal arguments", async () => {
    const source = [
      'text.includes("font-weight:bold");',
      "style.includes(property);",
      'style.split(";").includes("italic");',
      '$node.attr("class").includes("font-weight:bold");',
      '$("span[style]");',
      '$("span[data-style*=italic]");',
    ].join("\n");
    expect(
      await lintSingleRule(RULE_NAME, source, { sourcePath: PARSER }),
    ).toEqual([]);
  });

  test("handles receiver and selector case and spacing", async () => {
    expect(
      await lintSingleRule(
        RULE_NAME,
        'CSSStyle.includes("FONT-WEIGHT  :bold");\n$("span[ STYLE ^=italic]");',
        { sourcePath: VALIDATOR },
      ),
    ).toEqual([1, 2]);
  });

  test("scopes both parser trees and excludes tests and unrelated files per file", async () => {
    const source = hits.join("\n");
    const paths = [
      PARSER,
      VALIDATOR,
      "apps/api/src/handlers/case-law/ingestion/parsers/example.test.ts",
      "apps/api/src/lib/legal-search/parsers/example.spec.ts",
      "apps/api/src/handlers/case-law/ingestion/__tests__/example.ts",
      "apps/api/src/handlers/case-law/other.ts",
      "apps/api/src/lib/legal-search/document-builders/inline-style.ts",
    ];
    expect(
      await lintRuleAcrossFiles(
        RULE_NAME,
        Object.fromEntries(paths.map((file) => [file, source])),
      ),
    ).toEqual(
      Object.fromEntries(
        paths.map((file) => [
          file,
          file === PARSER || file === VALIDATOR
            ? hits.map((_, index) => index + 1)
            : [],
        ]),
      ),
    );
  });
});
