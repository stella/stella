import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

import createVerification from "@/api/handlers/lists/verifications/create";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch/lists.verifications.create";

const apiRoot = path.resolve(import.meta.dir, "../../../..");
const owner = "src/lib/lists/verification/start-run.ts";
const tableName = "legalListVerificationRuns";

const collectRunInserts = (source: string) => {
  const file = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const aliases = new Set([tableName]);
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === tableName) {
          aliases.add(binding.name.text);
        }
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  const isRunTable = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) {
      return aliases.has(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return (
        namespaces.has(node.expression.getText(file)) &&
        node.name.text === tableName
      );
    }
    if (ts.isElementAccessExpression(node)) {
      return (
        namespaces.has(node.expression.getText(file)) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === tableName
      );
    }
    return false;
  };
  const sites: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isRunTable(node.initializer)
    ) {
      aliases.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "insert"
    ) {
      const target = node.arguments.at(0);
      if (target && isRunTable(target)) {
        sites.push(node.getText(file));
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)) &&
      /\bINSERT\s+INTO\s+(?:"?\w+"?\.)?"?legal_list_verification_runs\b/iu.test(
        node.text,
      )
    ) {
      sites.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
};

test("every production verification insert is confined to the admission owner", async () => {
  const sites: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: apiRoot })) {
    if (file.includes("/tests/") || /\.(?:test|type-test)\.ts$/u.test(file)) {
      continue;
    }
    const inserts = collectRunInserts(
      await Bun.file(path.join(apiRoot, file)).text(),
    );
    for (const _insert of inserts) {
      sites.push(file);
    }
  }
  expect(sites).toEqual([owner]);
});

test("the census detects named aliases, namespace aliases, local aliases and raw SQL", () => {
  for (const source of [
    'import { legalListVerificationRuns as runs } from "@/api/db/schema"; tx.insert(runs);',
    'import * as tables from "@/api/db/schema"; tx.insert(tables.legalListVerificationRuns);',
    'import * as tables from "@/api/db/schema"; tx.insert(tables["legalListVerificationRuns"]);',
    'import { legalListVerificationRuns } from "@/api/db/schema"; const rows = legalListVerificationRuns; tx.insert(rows);',
    "tx.execute(sql`INSERT INTO public.legal_list_verification_runs (id) VALUES (1)`);",
  ]) {
    expect(collectRunInserts(source)).toHaveLength(1);
  }
  expect(collectRunInserts("tx.insert(legalListClaims);")).toHaveLength(0);
});

test("REST and generated MCP, CLI and chat capability dispatch share the create handler", async () => {
  const capability =
    await CAPABILITY_DISPATCH["lists.verifications.create"].load();
  expect(capability.default).toBe(createVerification);
});
