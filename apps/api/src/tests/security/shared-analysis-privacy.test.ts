import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../../../..");
const source = (relativePath: string) =>
  ts.createSourceFile(
    relativePath,
    readFileSync(path.join(root, relativePath), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );

const propertyNames = (node: ts.Node): string[] => {
  const names: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isPropertySignature(child) || ts.isPropertyAssignment(child)) {
      names.push(child.name.getText());
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names.toSorted();
};

const typeProperties = (file: ts.SourceFile, name: string) => {
  const declaration = file.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  expect(declaration, `Missing shared analysis type ${name}`).toBeDefined();
  if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
    return [];
  }
  // Index signatures, intersections and imported replacement types may widen
  // an allowlist without adding a named property, so they need review too.
  expect(ts.isTypeLiteralNode(declaration.type), name).toBe(true);
  if (!ts.isTypeLiteralNode(declaration.type)) {
    return [];
  }
  expect(declaration.type.members.every(ts.isPropertySignature), name).toBe(
    true,
  );
  return propertyNames(declaration.type);
};

const privateField =
  /^(?:user|owner|org|tenant|selection|question|answer|readeranswer)/iu;
const assertNoPrivateProperties = (
  file: ts.SourceFile,
  allowed: readonly string[] = [],
) => {
  const names = propertyNames(file).map((name) =>
    name.replaceAll(/["'_]/gu, ""),
  );
  expect(
    names.filter((name) => privateField.test(name) && !allowed.includes(name)),
  ).toEqual([]);
};

describe("shared vanilla analysis has corpus-only inputs and storage", () => {
  test("input and builder options admit only corpus text and resolved prompts", () => {
    const file = source("apps/api/src/lib/case-law/analysis-prompt.ts");
    expect(typeProperties(file, "AnalysisInput")).toEqual(
      ["language", "systemPrompt", "userMessage", "fingerprint"].toSorted(),
    );
    expect(typeProperties(file, "AnalysisPromptDecision")).toEqual(
      ["court", "country", "decisionType", "language"].toSorted(),
    );
    expect(typeProperties(file, "AnalysisInputOptions")).toEqual(
      [
        "blocks",
        "decision",
        "systemPrompt",
        "anchorId",
        "plainText",
        "type",
      ].toSorted(),
    );
    assertNoPrivateProperties(file, ["userMessage"]);
    assertNoPrivateProperties(
      source("apps/api/src/handlers/case-law/analysis/analysis-input.ts"),
    );
  });

  test("stored analysis identity and serialized schema have no owner or reader input", () => {
    const file = source("apps/api/src/lib/case-law/stored-analysis.ts");
    expect(typeProperties(file, "AnalysisStoreKey")).toEqual([
      "decisionId",
      "fingerprint",
    ]);
    assertNoPrivateProperties(file);
    assertNoPrivateProperties(
      source("apps/api/src/lib/case-law/analysis-store-core.ts"),
    );
    assertNoPrivateProperties(source("packages/legal-ast/src/analysis.ts"));
  });

  test("the shared corpus table has no tenant or reader-answer columns", () => {
    const file = source("apps/api/src/db/schema/case-law.ts");
    let columns: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText() === "caseLawDecisions"
      ) {
        expect(node.initializer && ts.isCallExpression(node.initializer)).toBe(
          true,
        );
        if (node.initializer && ts.isCallExpression(node.initializer)) {
          columns = node.initializer.arguments.at(1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(columns).toBeDefined();
    if (!columns) {
      return;
    }
    expect(ts.isObjectLiteralExpression(columns)).toBe(true);
    expect(propertyNames(columns)).toContain("analysis");
    expect(
      propertyNames(columns).filter((name) => privateField.test(name)),
    ).toEqual([]);
  });
});
