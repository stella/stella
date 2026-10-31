import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

// node:child_process' synchronous calls keep at most `maxBuffer` bytes of a
// child's output (1 MiB by default) and fail with ENOBUFS past it. A tracked
// file list, a diff or a log grows past that with the repository, so every
// call states its own limit.
const SYNC_CALLS = new Set(["execFileSync", "execSync", "spawnSync"]);
const CHILD_PROCESS = /^(?:node:)?child_process$/u;
const root = path.resolve(import.meta.dir, "..");

const callsWithoutMaxBuffer = (file: string, text: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const named = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !CHILD_PROCESS.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (SYNC_CALLS.has((element.propertyName ?? element.name).text)) {
          named.add(element.name.text);
        }
      }
    } else if (bindings !== undefined) {
      namespaces.add(bindings.name.text);
    }
    if (clause?.name !== undefined) {
      namespaces.add(clause.name.text);
    }
  }
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isSyncCall = ts.isIdentifier(callee)
        ? named.has(callee.text)
        : ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) &&
          SYNC_CALLS.has(callee.name.text);
      const states = node.arguments.some(
        (argument) =>
          ts.isObjectLiteralExpression(argument) &&
          argument.properties.some(
            (property) =>
              property.name !== undefined &&
              ts.isIdentifier(property.name) &&
              property.name.text === "maxBuffer",
          ),
      );
      if (isSyncCall && !states) {
        lines.push(
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
};

test("every synchronous child process call states its output limit", () => {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
      "*.mjs",
      "*.js",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(listed.exitCode).toBe(0);
  const missing = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file !== "")
    .flatMap((file) => {
      const text = readFileSync(path.join(root, file), "utf-8");
      return text.includes("child_process")
        ? callsWithoutMaxBuffer(file, text).map((line) => `${file}:${line}`)
        : [];
    });
  expect(missing).toEqual([]);
});

test("a call without its own limit is found, one with it is not", () => {
  const source = [
    'import { execFileSync, spawnSync as run } from "node:child_process";',
    'import * as child from "child_process";',
    'execFileSync("git", ["ls-files"]);',
    'run("git", ["status", "--porcelain"], { cwd: "." });',
    'child.execSync("ls");',
    'execFileSync("git", ["ls-files"], { maxBuffer: 2 ** 30 });',
    'Bun.spawnSync(["git", "ls-files"]);',
  ].join("\n");
  expect(callsWithoutMaxBuffer("fixture.ts", source)).toEqual([3, 4, 5]);
});
