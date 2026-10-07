import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects broad managed facades", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'import { db } from "@/api/db";\nimport { capture } from "@/api/lib/analytics";',
    ),
  ).toEqual([1, 2]);
});

test("rejects dynamic imports of unowned managed modules", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'const errors = import("@/lib/errors/shared");',
    ),
  ).toEqual([1]);
});

test("rejects leaf reexports that recreate a facade", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'export { capture } from "@/api/lib/analytics/capture";\nexport * from "@/api/db/schema";',
    ),
  ).toEqual([1, 2]);
});

test("accepts owning leaves imported directly", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'import { db } from "@/api/db/root";\nimport { capture } from "@/api/lib/analytics/capture";\nimport { APIError } from "@/lib/errors/api";',
    ),
  ).toEqual([]);
});

test("accepts unrelated module namespaces", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'import { capture } from "@/api/lib/analytics-extra";\nexport { format } from "./format";',
    ),
  ).toEqual([]);
});

test("rejects both removed AST facades and their type imports", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'import { hasUsableAst } from "@/api/handlers/case-law/document-ast";',
        'import type { DocumentAst } from "@/api/handlers/case-law/document-ast";',
        'import { plainTextOf } from "@/api/lib/case-law/document-ast";',
        'import type { Inline } from "@/api/lib/case-law/document-ast";',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects reexports and dynamic imports of removed AST facades", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'export { hasUsableAst } from "@/api/handlers/case-law/document-ast";',
        'export type { DocumentAst } from "@/api/lib/case-law/document-ast";',
        'const handlerAst = import("@/api/handlers/case-law/document-ast");',
        'const libAst = import("@/api/lib/case-law/document-ast");',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects relative imports resolving to removed AST facades", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'import type { DocumentAst } from "../../document-ast";',
        'const ast = import("../../document-ast");',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath:
          "apps/api/src/handlers/case-law/ingestion/parsers/sample.ts",
      },
    ),
  ).toEqual([1, 2]);
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'export { hasUsableAst } from "./document-ast";',
        'const ast = import("./document-ast");',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath: "apps/api/src/lib/case-law/sample.ts",
      },
    ),
  ).toEqual([1, 2]);
});

test("accepts direct canonical AST imports and reexports", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'import { hasUsableAst } from "@stll/legal-ast/document-ast";',
        'import type { DocumentAst } from "@stll/legal-ast/document-ast";',
        'export { plainTextOf } from "@stll/legal-ast/document-ast";',
        'const ast = import("@stll/legal-ast/document-ast");',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("type queries reject retired facades while accepting the package owner", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'type HandlerAst = import("@/api/handlers/case-law/document-ast").DocumentAst;',
        'type LibAst = import("@/api/lib/case-law/document-ast").DocumentAst;',
        'type OwnerAst = import("@stll/legal-ast/document-ast").DocumentAst;',
        'type RelativeAst = import("../../document-ast").DocumentAst;',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath:
          "apps/api/src/handlers/case-law/ingestion/parsers/sample.ts",
      },
    ),
  ).toEqual([1, 2, 4]);
});
