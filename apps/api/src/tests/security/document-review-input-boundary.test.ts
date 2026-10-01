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

const callsNamed = (source: ts.SourceFile, name: string) => {
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
    const calls = callsNamed(source, "createMembershipScopedDb");
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      const options = call.arguments.at(1);
      expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
      if (!options || !ts.isObjectLiteralExpression(options)) {
        continue;
      }
      const property = options.properties.find(
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
