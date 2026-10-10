import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// The browser launcher deliberately hands ownership to the user's desktop.
// Every other asynchronous process in the runner belongs to its dev session.
const unownedSpawns = (source: string) => {
  const file = ts.createSourceFile(
    "dev-runner.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node, owner: string) => {
    let currentOwner = owner;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      currentOwner = node.name.text;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:child_process"
    ) {
      violations.push("raw node child process import");
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const rawSpawn =
        (ts.isPropertyAccessExpression(expression) &&
          expression.expression.getText(file) === "Bun" &&
          expression.name.text === "spawn") ||
        (ts.isElementAccessExpression(expression) &&
          expression.expression.getText(file) === "Bun" &&
          ts.isStringLiteral(expression.argumentExpression) &&
          expression.argumentExpression.text === "spawn");
      if (rawSpawn && currentOwner !== "openBrowser") {
        violations.push(`unowned spawn in ${currentOwner}`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, currentOwner));
  };
  visit(file, "module");
  return violations;
};
const source = readFileSync(new URL("dev-runner.ts", import.meta.url), "utf-8");

test("dev runner services can only start through the recorded process-group owner", () => {
  expect(unownedSpawns(source)).toEqual([]);
});
for (const bypass of [
  "Bun.spawn(['server'])",
  "Bun['spawn'](['server'])",
  "import { spawn } from 'node:child_process'",
]) {
  test(`raw process-group bypass is rejected: ${bypass}`, () => {
    expect(
      unownedSpawns(`${source}\nconst newService = () => { ${bypass}; };`),
    ).not.toEqual([]);
  });
}
