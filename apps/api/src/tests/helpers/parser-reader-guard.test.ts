import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { assertReaderAcceptsAst, guardParser } from "./parser-reader-guard";

const ast = {
  version: 1,
  source: {
    system: "fixture",
    documentId: "fixture",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      type: "paragraph",
      id: "b1",
      anchorId: "p1",
      inlines: [{ type: "text", text: "First paragraph." }],
      plainText: "First paragraph.",
    },
    {
      type: "paragraph",
      id: "b2",
      anchorId: "p2",
      inlines: [{ type: "text", text: "Second paragraph." }],
      plainText: "Second paragraph.",
    },
  ],
} as const satisfies DocumentAst;

test("the shared fixture guard rejects a duplicate-anchor mutation accepted by parser types", () => {
  assertReaderAcceptsAst(ast);
  const duplicate = {
    ...ast,
    blocks: ast.blocks.map((block) => ({ ...block, anchorId: "p1" })),
  };
  const parse = guardParser(() => ({ documentAst: duplicate }));
  expect(() => parse()).toThrow(v.ValiError);
});

test("asynchronous parser fixtures use the same reader guard", async () => {
  const parse = guardParser(async () => ({ documentAst: ast }));
  expect((await parse()).documentAst).toBe(ast);
});

test("every registered source owns a parser fixture guard", async () => {
  const { ADAPTER_KEYS, IMPORT_SOURCE_KEYS } =
    await import("@/api/lib/legal-search/ingestion-constants");
  const { PARSER_FIXTURE_OWNERS } = await import("./parser-fixture-owners");
  expect(Object.keys(PARSER_FIXTURE_OWNERS).toSorted()).toEqual(
    [
      ...Object.values(ADAPTER_KEYS),
      ...Object.values(IMPORT_SOURCE_KEYS),
    ].toSorted(),
  );
});

test("declared parser owners equal the entry points exercised through fixture guards", async () => {
  const { parseSource, walk } = await import("@stll/scripts/src/syntax-tree");
  const { PARSER_FIXTURE_OWNERS } = await import("./parser-fixture-owners");
  const declared = new Set(Object.values(PARSER_FIXTURE_OWNERS).flat());
  const exercised = new Set<string>();
  const root = new URL("../../", import.meta.url);
  const fixtureSources = new Bun.Glob("**/*.ts");
  for await (const file of fixtureSources.scan(fileURLToPath(root))) {
    const parserFixture =
      (file.startsWith("handlers/case-law/ingestion/") ||
        file.startsWith("lib/legal-search/parsers/")) &&
      file.endsWith(".test.ts");
    if (!parserFixture && !file.startsWith("tests/helpers/")) {
      continue;
    }
    const source = await Bun.file(new URL(file, root)).text();
    if (!source.includes("guardParser")) {
      continue;
    }
    const { program } = parseSource(file, source);
    const imports = new Map<string, string>();
    const namespaces = new Set<string>();
    const guards = new Set<string>();
    for (const statement of program.body) {
      if (statement.type !== "ImportDeclaration") {
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local.name);
          continue;
        }
        if (specifier.type !== "ImportSpecifier") {
          continue;
        }
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        if (
          imported === "guardParser" &&
          /(?:^|\/)parser-reader-guard(?:\.ts)?$/u.test(statement.source.value)
        ) {
          guards.add(specifier.local.name);
          continue;
        }
        imports.set(specifier.local.name, imported);
      }
    }
    walk(program, (node) => {
      if (
        node.type !== "CallExpression" ||
        node.callee.type !== "Identifier" ||
        !guards.has(node.callee.name)
      ) {
        return;
      }
      const parser = node.arguments.at(0);
      if (parser?.type === "Identifier") {
        const imported = imports.get(parser.name);
        if (imported !== undefined) {
          exercised.add(imported);
        }
        return;
      }
      if (
        parser?.type !== "MemberExpression" ||
        parser.object.type !== "Identifier" ||
        !namespaces.has(parser.object.name)
      ) {
        return;
      }
      if (!parser.computed && parser.property.type === "Identifier") {
        exercised.add(parser.property.name);
      } else if (
        parser.property.type === "Literal" &&
        typeof parser.property.value === "string"
      ) {
        exercised.add(parser.property.value);
      }
    });
  }
  expect([...exercised].toSorted()).toEqual([...declared].toSorted());
});
