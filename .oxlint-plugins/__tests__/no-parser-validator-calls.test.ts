import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-parser-validator-calls";

setDefaultTimeout(20_000);

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "adapter.ts" });

describe.serial("no-parser-validator-calls", () => {
  test("accepts parsing without runtime validator imports or calls", async () => {
    expect(
      await lint(
        [
          'import type { validateAst } from "./validate-ast";',
          'export type { validateAndLog } from "./validator-facade";',
          "const parsed = parser.parse(source);",
          "export { parsed };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("charges source-bearing validator re-exports, including renamed facade exports", async () => {
    expect(
      await lint(
        [
          'export { validateAndLog as check } from "./validator-facade";',
          'export { validateAst as checkAst } from "./validator-facade";',
          'export type { validateAst as ValidatorType } from "./validator-facade";',
          'export { type validateAst } from "./validator-facade";',
          "const validateAst = () => {}; export { validateAst };",
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("computed names use literal values and scoped constant string bindings", async () => {
    expect(
      await lint(
        [
          "declare const oracle: any;",
          'oracle["validateAst"]();',
          "oracle[`validateAst`]();",
          'const validatorProperty = "validateAndLog"; oracle[validatorProperty]();',
          '{ const validateAst = "differentMethod"; oracle[validateAst](); }',
          'const validateAst = "validateAndLog";',
          '{ const validateAst = "differentMethod"; oracle[validateAst](); }',
          "oracle[validateAst]();",
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 8]);
  });

  test("unknown computed oracle accesses are charged without flagging unrelated objects", async () => {
    expect(
      await lint(
        [
          'import * as oracle from "./validate-ast";',
          "declare const dynamic: string; oracle[dynamic]();",
          'let mutable = "safe"; mutable = dynamic; oracle[mutable]();',
          "const generated = getKey(); oracle[generated]();",
          'const safe = "differentMethod"; oracle[safe]();',
          // oxlint-disable-next-line no-template-curly-in-string -- fixture source preserves a runtime template expression
          "oracle[`validate${dynamic}`]();",
          "declare const unrelated: any; unrelated[dynamic]();",
          "const alias = oracle; alias[dynamic]();",
          "function local(oracle: any) { oracle[dynamic](); }",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 6, 8]);
  });
});
