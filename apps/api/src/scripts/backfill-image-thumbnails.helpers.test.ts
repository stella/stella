import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

describe("chat thumbnail backfill query", () => {
  test("keeps the chat thread join inside the usage tracking branch", () => {
    const helperPath = path.resolve(
      import.meta.dir,
      "../../scripts/backfill-image-thumbnails.helpers.ts",
    );
    const source = ts.createSourceFile(
      helperPath,
      fs.readFileSync(helperPath, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements.find(
      (statement): statement is ts.VariableStatement =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (item) =>
            ts.isIdentifier(item.name) &&
            item.name.text === "buildChatThumbnailQuery",
        ),
    );
    const initializer =
      declaration?.declarationList.declarations.at(0)?.initializer;
    const branch =
      initializer &&
      ts.isArrowFunction(initializer) &&
      ts.isBlock(initializer.body)
        ? initializer.body.statements.find(ts.isIfStatement)
        : undefined;
    expect(branch).toBeDefined();
    const callsInnerJoin = (node: ts.Node) => {
      let found = false;
      const visit = (child: ts.Node) => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === "innerJoin"
        ) {
          found = true;
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return found;
    };
    expect(callsInnerJoin(branch!.thenStatement)).toBe(false);
    expect(
      initializer &&
        ts.isArrowFunction(initializer) &&
        ts.isBlock(initializer.body) &&
        initializer.body.statements
          .slice(initializer.body.statements.indexOf(branch!) + 1)
          .some(callsInnerJoin),
    ).toBe(true);
  });
});
