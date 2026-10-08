import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const successPhase = (source: string): string => {
  const parsed = ts.createSourceFile(
    "script.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let body: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runScriptWithErrorOutput"
    ) {
      const callback = node.arguments.at(0);
      if (
        callback &&
        ts.isArrowFunction(callback) &&
        ts.isBlock(callback.body)
      ) {
        body = callback.body;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!body) {
    throw new TypeError("Script entrypoint output boundary missing");
  }
  const statements = body.statements;
  const outputIndex = statements.findLastIndex((statement) => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      return false;
    }
    const callee = statement.expression.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "console" &&
      callee.name.text === "log"
    );
  });
  if (outputIndex === -1) {
    throw new TypeError("Script success output missing");
  }
  return statements
    .slice(outputIndex)
    .map((statement) => statement.getText(parsed))
    .join("\n");
};

for (const { path, output, fixtures } of [
  {
    path: "./corpus-snippet-compare.ts",
    output: "wrote fixture.json and fixture.md",
    fixtures:
      'const jsonPath = "fixture.json"; const markdownPath = "fixture.md";',
  },
  { path: "../../scripts/seed-templates.ts", output: "Done.", fixtures: "" },
]) {
  test(`${path} terminates after successful output with an open session handle`, async () => {
    const source = await readFile(new URL(path, import.meta.url), "utf-8");
    // Execute the real terminal statements, retaining a live handle as an open
    // database session would. Earlier database work has already succeeded.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
        import { runScriptWithErrorOutput } from ${JSON.stringify(import.meta.resolve("@stll/errors"))};
        setInterval(() => {}, 1000);
        ${fixtures}
        await runScriptWithErrorOutput(async () => { ${successPhase(source)} });
      `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 2000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stdout).toContain(output);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
    } finally {
      clearTimeout(deadline);
    }
  });
}
