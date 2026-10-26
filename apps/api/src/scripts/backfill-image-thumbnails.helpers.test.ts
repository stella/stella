import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript6";

describe("chat thumbnail backfill query", () => {
  test("always joins the chat thread for organization ownership", () => {
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
    expect(initializer && ts.isArrowFunction(initializer)).toBe(true);
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
    expect(initializer && callsInnerJoin(initializer)).toBe(true);
    expect(fs.readFileSync(helperPath, "utf-8")).toContain(
      "organizationId: chatThreads.organizationId",
    );
  });
});
