import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  type FunctionBody,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const successPhase = (source: string): string => {
  const parsed = parseSource("script.ts", source);
  let body: FunctionBody | undefined;
  walk(parsed.program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "runScriptWithErrorOutput"
    ) {
      const callback = node.arguments.at(0);
      if (
        callback?.type === "ArrowFunctionExpression" &&
        callback.body.type === "BlockStatement"
      ) {
        body = callback.body;
      }
    }
  });
  if (!body) {
    throw new TypeError("Script entrypoint output boundary missing");
  }
  const statements = body.body;
  const outputIndex = statements.findLastIndex((statement) => {
    if (
      statement.type !== "ExpressionStatement" ||
      statement.expression.type !== "CallExpression"
    ) {
      return false;
    }
    const callee = statement.expression.callee;
    return (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.object.name === "console" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "log"
    );
  });
  if (outputIndex === -1) {
    throw new TypeError("Script success output missing");
  }
  return statements
    .slice(outputIndex)
    .map((statement) => source.slice(statement.start, statement.end))
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
        import { runScriptWithErrorOutput } from ${JSON.stringify(import.meta.resolve("@stll/errors/script-error"))};
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
