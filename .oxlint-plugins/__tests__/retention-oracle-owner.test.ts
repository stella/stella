import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const LOGGING_ORACLE_IMPORTS = [
  'import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";',
  'import { validateAndLog as report } from "../../../../lib/legal-search/parsers/validate-ast";',
  'import * as oracle from "@/api/lib/legal-search/parsers/validate-ast"; oracle.validateAndLog({ parser: "p" }, "", []);',
  'export { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";',
].join("\n");

test("a parser may not log the retention signal, however it reaches it", async () => {
  expect(
    await lintSingleRule("retention-oracle-owner", LOGGING_ORACLE_IMPORTS, {
      cwd: "scratch",
      sourcePath: "apps/api/src/handlers/case-law/ingestion/parsers/planted.ts",
    }),
  ).toEqual([1, 2, 3, 4]);
});

test("the logging oracle reached through a constant module name is reported", async () => {
  expect(
    await lintSingleRule(
      "retention-oracle-owner",
      [
        'const ORACLE = "@/api/lib/legal-search/parsers/validate-ast";',
        "const oracle = await import(ORACLE);",
        'oracle.validateAndLog({ parser: "p", caseNumber: "c" }, "", []);',
        'export const verdict = (await import(ORACLE)).validateAst("", []);',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath:
          "apps/api/src/handlers/case-law/ingestion/parsers/planted.ts",
      },
    ),
  ).toEqual([3]);
});

test("the retention check owns the logging oracle", async () => {
  expect(
    await lintSingleRule(
      "retention-oracle-owner",
      'import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";',
      {
        cwd: "scratch",
        sourcePath:
          "apps/api/src/handlers/case-law/ingestion/retention/retention-check.ts",
      },
    ),
  ).toEqual([]);
});

test("a parser may measure with validateAst to choose between parses", async () => {
  expect(
    await lintSingleRule(
      "retention-oracle-owner",
      [
        'import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";',
        'import { validateAst as measure } from "../../../../lib/legal-search/parsers/validate-ast";',
        'import * as oracle from "@/api/lib/legal-search/parsers/validate-ast"; oracle.validateAst("", []);',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath:
          "apps/api/src/handlers/case-law/ingestion/parsers/planted.ts",
      },
    ),
  ).toEqual([]);
});

test("types and the oracle's other helpers stay importable", async () => {
  expect(
    await lintSingleRule(
      "retention-oracle-owner",
      [
        'import type { ValidationSource, validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";',
        'import { buildValidationHtml, storedDecisionSignal } from "@/api/lib/legal-search/parsers/validate-ast";',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath:
          "apps/api/src/handlers/case-law/ingestion/pipeline/planted.ts",
      },
    ),
  ).toEqual([]);
});
