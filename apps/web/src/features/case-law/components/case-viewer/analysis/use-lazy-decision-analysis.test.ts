import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const featureRoot = path.resolve(import.meta.dir, "../../..");
const sourceOf = (relativePath: string) =>
  ts.createSourceFile(
    relativePath,
    readFileSync(path.join(featureRoot, relativePath), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const importedCalls = (source: ts.SourceFile, exportedName: string) => {
  const localNames = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    if (
      exportedName === "useLazyDecisionAnalysis" &&
      (!ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !==
          "@/features/case-law/components/case-viewer/analysis/use-lazy-decision-analysis")
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const binding of bindings.elements) {
      if (
        !binding.isTypeOnly &&
        (binding.propertyName?.text ?? binding.name.text) === exportedName
      ) {
        localNames.add(binding.name.text);
      }
    }
  }
  let calls = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      calls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
};

describe("shared decision analysis ownership", () => {
  test("the reader and inspector both call the same lazy owner", () => {
    for (const file of [
      "components/case-viewer/decision-workspace.tsx",
      "components/case-decision-inspector-view.tsx",
    ]) {
      const source = sourceOf(file);
      expect(
        importedCalls(source, "useLazyDecisionAnalysis"),
        `${file} must use the shared lazy gate`,
      ).toBe(1);
      expect(importedCalls(source, "useDecisionAnalysis")).toBe(0);
    }
  });

  test("all low-level generation callers belong to the shared lazy gate", () => {
    const callers: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({
      cwd: featureRoot,
    })) {
      if (/\.(test|gen)\./u.test(file)) {
        continue;
      }
      if (importedCalls(sourceOf(file), "useDecisionAnalysis") > 0) {
        callers.push(file);
      }
    }
    expect(callers).toEqual([
      "components/case-viewer/analysis/use-lazy-decision-analysis.ts",
    ]);
  });
});
