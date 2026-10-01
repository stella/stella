import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const readModule = (relativePath: string) =>
  ts.createSourceFile(
    relativePath,
    readFileSync(new URL(relativePath, import.meta.url), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

const callsNamed = (source: ts.Node, name: string) => {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
};

describe("document review input boundary", () => {
  test("run input resolution uses the current membership scope", () => {
    const source = readModule("../../lib/document-review/run-queue.ts");
    const calls = callsNamed(source, "resolveDocumentReviewRunInputs");
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call.arguments.at(0)?.getText(source)).toBe(
        "createRootMembershipScopedDb(actor)",
      );
    }
    expect(callsNamed(source, "readReferencePassageTexts")).toHaveLength(0);
  });

  test("the current membership scope adds no stored workspace ids", () => {
    const source = readModule("../../lib/root-scoped-db.ts");
    const factory = source.statements.find(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (declaration) =>
            declaration.name.getText(source) === "createRootMembershipScopedDb",
        ),
    );
    expect(factory).toBeDefined();
    if (!factory) {
      return;
    }
    const calls = callsNamed(factory, "createRootScopedDb");
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      const options = call.arguments.at(0);
      expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
      if (!options || !ts.isObjectLiteralExpression(options)) {
        continue;
      }
      const scope = options.properties.find(
        (node) =>
          ts.isPropertyAssignment(node) &&
          node.name.getText(source) === "workspaceScope",
      );
      expect(scope && ts.isPropertyAssignment(scope)).toBe(true);
      if (!scope || !ts.isPropertyAssignment(scope)) {
        continue;
      }
      const scopeOptions = scope.initializer;
      expect(ts.isObjectLiteralExpression(scopeOptions)).toBe(true);
      if (!ts.isObjectLiteralExpression(scopeOptions)) {
        continue;
      }
      const mode = scopeOptions.properties.find(
        (node) =>
          ts.isPropertyAssignment(node) && node.name.getText(source) === "type",
      );
      expect(mode && ts.isPropertyAssignment(mode)).toBe(true);
      if (!mode || !ts.isPropertyAssignment(mode)) {
        continue;
      }
      expect(mode.initializer.getText(source)).toBe(
        "WORKSPACE_ACCESS_MODE.membership",
      );
      const property = scopeOptions.properties.find(
        (node) =>
          ts.isPropertyAssignment(node) &&
          node.name.getText(source) === "serverValidatedWorkspaceIds",
      );
      expect(property && ts.isPropertyAssignment(property)).toBe(true);
      if (!property || !ts.isPropertyAssignment(property)) {
        continue;
      }
      expect(property.initializer.getText(source)).toBe("[]");
    }
  });
});
