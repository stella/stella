import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;
const SPAWN_NAMES = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);

const propertyName = (node: ts.Node): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return undefined;
};

const isProcessExecPath = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "process" &&
  node.name.text === "execPath";

const literalCommand = (node: ts.Expression | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

const commandElements = (node: ts.Expression | undefined) =>
  node && ts.isArrayLiteralExpression(node) ? node.elements : undefined;

const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

const inspectCommand = (
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  executable: ts.Expression | undefined,
  args: readonly ts.Expression[],
  violations: string[],
) => {
  const command = literalCommand(executable);
  if (command === "bun" || command === "bunx") {
    violations.push(
      `${file}:${lineOf(source, node)} spawns ${command} by name; use bunExecutable() or bunxCommand().`,
    );
    return;
  }

  if (!executable || !isProcessExecPath(executable)) {
    return;
  }
  const firstArgument = literalCommand(args.at(0));
  if (
    firstArgument === "test" ||
    firstArgument === "run" ||
    firstArgument?.endsWith(".ts") ||
    firstArgument?.endsWith(".mts") ||
    firstArgument?.endsWith(".js") ||
    firstArgument?.endsWith(".mjs")
  ) {
    violations.push(
      `${file}:${lineOf(source, node)} spawns a Bun script through process.execPath; use bunExecutable().`,
    );
  }
};

const violationsIn = (file: string) => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      SPAWN_NAMES.has(propertyName(node.expression) ?? "")
    ) {
      const array = commandElements(node.arguments.at(0));
      if (array) {
        inspectCommand(
          file,
          source,
          node,
          array.at(0) as ts.Expression,
          array.slice(1) as ts.Expression[],
          violations,
        );
      } else {
        const args = commandElements(node.arguments.at(1));
        inspectCommand(
          file,
          source,
          node,
          node.arguments.at(0),
          (args ?? []) as ts.Expression[],
          violations,
        );
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      ["cmd", "command"].includes(propertyName(node.name) ?? "")
    ) {
      const array = commandElements(node.initializer);
      if (array) {
        inspectCommand(
          file,
          source,
          node,
          array.at(0) as ts.Expression,
          array.slice(1) as ts.Expression[],
          violations,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

test("tracked sources never spawn Bun by name or through a bare execPath", () => {
  const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "buffer" });
  expect(tracked.status).toBe(0);
  const files = tracked.stdout
    .toString()
    .split("\0")
    .filter((file) => SOURCE_PATTERN.test(file));
  const violations = files.flatMap(violationsIn);
  expect(violations).toEqual([]);
}, 30_000);
