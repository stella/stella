import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseSource, walk } from "./syntax-tree";

// The browser launcher deliberately hands ownership to the user's desktop.
// Every other asynchronous process in the runner belongs to its dev session.
const unownedSpawns = (source: string) => {
  const file = parseSource("dev-runner.ts", source);
  const violations: string[] = [];
  walk(file.program, (node, ancestors) => {
    const owner = ancestors.findLast(
      (candidate) =>
        candidate.type === "VariableDeclarator" &&
        candidate.id.type === "Identifier" &&
        (candidate.init?.type === "ArrowFunctionExpression" ||
          candidate.init?.type === "FunctionExpression"),
    );
    const currentOwner =
      owner?.type === "VariableDeclarator" && owner.id.type === "Identifier"
        ? owner.id.name
        : "module";
    if (
      node.type === "ImportDeclaration" &&
      node.source.value === "node:child_process"
    ) {
      violations.push("raw node child process import");
    }
    if (node.type !== "CallExpression") {
      return;
    }
    const expression = node.callee;
    const rawSpawn =
      expression.type === "MemberExpression" &&
      source.slice(expression.object.start, expression.object.end) === "Bun" &&
      ((!expression.computed &&
        expression.property.type === "Identifier" &&
        expression.property.name === "spawn") ||
        (expression.computed &&
          expression.property.type === "Literal" &&
          expression.property.value === "spawn"));
    if (rawSpawn && currentOwner !== "openBrowser") {
      violations.push(`unowned spawn in ${currentOwner}`);
    }
  });
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
