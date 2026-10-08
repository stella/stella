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

for (const { form, source } of [
  {
    form: "static imports",
    source: (module: string) => `import { DocumentAst } from "${module}";`,
  },
  {
    form: "type imports",
    source: (module: string) => `import type { DocumentAst } from "${module}";`,
  },
  {
    form: "side-effect imports",
    source: (module: string) => `import "${module}";`,
  },
  {
    form: "named reexports",
    source: (module: string) => `export { DocumentAst } from "${module}";`,
  },
  {
    form: "type reexports",
    source: (module: string) => `export type { DocumentAst } from "${module}";`,
  },
  {
    form: "star reexports",
    source: (module: string) => `export * from "${module}";`,
  },
  {
    form: "namespace reexports",
    source: (module: string) => `export * as ast from "${module}";`,
  },
  {
    form: "dynamic imports",
    source: (module: string) => `const ast = import("${module}");`,
  },
  {
    form: "type queries",
    source: (module: string) => `type Ast = import("${module}").DocumentAst;`,
  },
  {
    form: "import-equals declarations",
    source: (module: string) => `import ast = require("${module}");`,
  },
  {
    form: "type import-equals declarations",
    source: (module: string) => `import type ast = require("${module}");`,
  },
]) {
  test(`${form} enforce the same retired module boundary`, async () => {
    for (const module of [
      "@/api/handlers/case-law/document-ast",
      "@/api/lib/case-law/document-ast",
      "../../document-ast",
    ]) {
      expect(
        await lintSingleRule("no-facade-imports", source(module), {
          cwd: "scratch",
          sourcePath:
            "apps/api/src/handlers/case-law/ingestion/parsers/sample.ts",
        }),
      ).toEqual([1]);
    }
    expect(
      await lintSingleRule(
        "no-facade-imports",
        source("@stll/legal-ast/document-ast"),
      ),
    ).toEqual([]);
  });
}

test("import-equals declarations preserve managed leaf ownership", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      [
        'import db = require("@/api/db");',
        'import root = require("@/api/db/root");',
        'import errors = require("@/lib/errors/shared");',
        'import unrelated = require("another-package");',
        "import alias = Namespace.Member;",
      ].join("\n"),
    ),
  ).toEqual([1, 3]);
});
