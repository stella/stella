import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import { sourceWriteExceptionIssues } from "./test-source-write-exceptions";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
export const writers = new Map([
  ["writeFileSync", [0]],
  ["writeFile", [0]],
  ["write", [0]],
  ["appendFileSync", [0]],
  ["appendFile", [0]],
  ["mkdirSync", [0]],
  ["mkdir", [0]],
  ["mkdtempSync", [0]],
  ["mkdtemp", [0]],
  ["copyFileSync", [1]],
  ["copyFile", [1]],
  ["cpSync", [1]],
  ["cp", [1]],
  ["renameSync", [0, 1]],
  ["rename", [0, 1]],
  ["symlinkSync", [1]],
  ["symlink", [1]],
]);

type ResolvePathCallOptions = {
  name: string | undefined;
  values: (string | undefined)[];
  packageRoot: string;
};

const resolvePathCall = ({
  name,
  values,
  packageRoot,
}: ResolvePathCallOptions) => {
  if (name === "join" || name === "resolve") {
    if (values.every((value) => value === undefined)) {
      return undefined;
    }
    const segments = values.map((value) => value ?? "__dynamic__");
    return name === "join"
      ? path.join(...segments)
      : path.resolve(packageRoot, ...segments);
  }
  const first = values.at(0);
  if (first === undefined) {
    return undefined;
  }
  if (name === "dirname") {
    return path.dirname(first);
  }
  if (name === "fileURLToPath") {
    return first.startsWith("file://") ? first.slice(7) : first;
  }
  if (name === "mkdtempSync" || name === "mkdtemp" || name === "file") {
    return first;
  }
  return undefined;
};

type SourcePathEvaluatorOptions = {
  absoluteFile: string;
  packageRoot: string;
  bindingFor: (node: ts.Identifier) => ts.Expression | undefined;
  callName: (node: ts.Expression) => string | undefined;
};

const createSourcePathEvaluator = ({
  absoluteFile,
  packageRoot,
  bindingFor,
  callName,
}: SourcePathEvaluatorOptions) => {
  const evaluatePath = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    const nextSeen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) {
      return node.text;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "__dirname") {
        return path.dirname(absoluteFile);
      }
      const initializer = bindingFor(node);
      return initializer === undefined
        ? undefined
        : evaluatePath(initializer, nextSeen);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression)
    ) {
      if (node.name.text === "dir" || node.name.text === "dirname") {
        return path.dirname(absoluteFile);
      }
      if (node.name.text === "url") {
        return `file://${absoluteFile}`;
      }
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return evaluatePath(node.expression, nextSeen);
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        value += `${evaluatePath(span.expression, nextSeen) ?? "__dynamic__"}${span.literal.text}`;
      }
      return value;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = evaluatePath(node.left, nextSeen);
      const right = evaluatePath(node.right, nextSeen);
      return left === undefined && right === undefined
        ? undefined
        : `${left ?? "__dynamic__"}${right ?? "__dynamic__"}`;
    }
    if (ts.isNewExpression(node) && callName(node.expression) === "URL") {
      return evaluateUrl(node, nextSeen);
    }
    if (!ts.isCallExpression(node)) {
      return undefined;
    }
    const name = callName(node.expression);
    if (name === "tmpdir") {
      return "/__outside_repository_tmp__";
    }
    const values = node.arguments.map((argument) =>
      evaluatePath(argument, nextSeen),
    );
    return resolvePathCall({ name, values, packageRoot });
  };
  const evaluateUrl = (node: ts.NewExpression, seen: Set<ts.Node>) => {
    const relative = node.arguments?.at(0);
    const base = node.arguments?.at(1);
    const relativeValue =
      relative === undefined ? undefined : evaluatePath(relative, seen);
    const baseValue = base === undefined ? undefined : evaluatePath(base, seen);
    if (relativeValue !== undefined && baseValue?.startsWith("file://")) {
      return path.resolve(path.dirname(baseValue.slice(7)), relativeValue);
    }
    return undefined;
  };
  return evaluatePath;
};

export const inspectSourceWrites = (source: string, file: string) => {
  const violations: string[] = [];
  if (
    !/write|mkdir|mkdtemp|append|copyFile|cp|rename|symlink|\\/u.test(source)
  ) {
    return violations;
  }
  const absoluteFile = path.resolve(repositoryRoot, file);
  const packageRoot = path.resolve(
    repositoryRoot,
    file.split("/").slice(0, 2).join("/"),
  );
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<ts.Node, Map<string, ts.Expression>>();
  const aliases = new Map<string, string>();
  const scopeOf = (node: ts.Node): ts.Node => {
    let scope = node.parent;
    while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
      scope = scope.parent;
    }
    return scope;
  };
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      aliases.set(node.name.text, (node.propertyName ?? node.name).text);
    }
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.propertyName !== undefined &&
      ts.isIdentifier(node.propertyName)
    ) {
      aliases.set(node.name.text, node.propertyName.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const scope = scopeOf(node);
      let entries = bindings.get(scope);
      if (entries === undefined) {
        entries = new Map();
        bindings.set(scope, entries);
      }
      entries.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const bindingFor = (node: ts.Identifier) => {
    let scope = node.parent;
    while (true) {
      const initializer = bindings.get(scope)?.get(node.text);
      if (initializer !== undefined) {
        return initializer;
      }
      if (ts.isSourceFile(scope)) {
        return undefined;
      }
      scope = scope.parent;
    }
  };
  const callName = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    if (seen.has(expression)) {
      return undefined;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = bindingFor(expression);
      if (initializer !== undefined) {
        return callName(initializer, new Set(seen).add(expression));
      }
      return expression.text === "write" && !aliases.has(expression.text)
        ? undefined
        : (aliases.get(expression.text) ?? expression.text);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (
        expression.name.text === "write" &&
        callName(expression.expression, new Set(seen).add(expression)) !== "Bun"
      ) {
        return undefined;
      }
      return expression.name.text;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression)
    ) {
      if (
        expression.argumentExpression.text === "write" &&
        callName(expression.expression, new Set(seen).add(expression)) !== "Bun"
      ) {
        return undefined;
      }
      return expression.argumentExpression.text;
    }
    return undefined;
  };
  const evaluatePath = createSourcePathEvaluator({
    absoluteFile,
    packageRoot,
    bindingFor,
    callName,
  });
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      let scope = node.parent;
      while (
        !ts.isSourceFile(scope) &&
        !bindings.get(scope)?.has(node.left.text)
      ) {
        scope = scope.parent;
      }
      const targetScope = bindings.get(scope)?.has(node.left.text)
        ? scope
        : scopeOf(node);
      let entries = bindings.get(targetScope);
      if (entries === undefined) {
        entries = new Map();
        bindings.set(targetScope, entries);
      }
      entries.set(node.left.text, node.right);
    }
    const writer = ts.isCallExpression(node)
      ? callName(node.expression)
      : undefined;
    const argumentIndexes =
      writer === undefined ? undefined : writers.get(writer);
    if (
      ts.isCallExpression(node) &&
      writer !== undefined &&
      argumentIndexes !== undefined
    ) {
      for (const argumentIndex of argumentIndexes) {
        const destination = node.arguments.at(argumentIndex);
        const value =
          destination === undefined ? undefined : evaluatePath(destination);
        if (value !== undefined) {
          const base = /^(?:apps|packages)\//u.test(value)
            ? repositoryRoot
            : packageRoot;
          const relative = repoRelativePath(
            repositoryRoot,
            path.resolve(base, value),
          );
          if (/^(?:apps|packages)\/[^/]+\/src(?:\/|$)/u.test(relative)) {
            const { line } = tree.getLineAndCharacterOfPosition(
              node.getStart(tree),
            );
            violations.push(
              `${file}:${line + 1}: ${writer} writes into src (${relative})`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
};

export const filesToInspect = (root: string) =>
  [
    ...new Bun.Glob(
      "{apps,packages}/*/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    ).scanSync({ cwd: root, onlyFiles: true }),
  ].filter(
    (file) =>
      /\.(?:test|spec|test-helpers|test-fixtures)\.[cm]?[jt]sx?$/u.test(file) ||
      /\/(?:tests|__tests__|test-helpers|test-fixtures)\//u.test(file),
  );

type RunSourceWriteCensusOptions = {
  budgetMs: number;
  entrypoint?: string;
};

export const runSourceWriteCensus = ({
  budgetMs,
  entrypoint = import.meta.path,
}: RunSourceWriteCensusOptions) => {
  // A child owns synchronous parsing and Git: its deadline cannot interrupt
  // the parent assertion or masquerade as a ledger failure.
  const child = spawnSync(process.execPath, ["--no-env-file", entrypoint], {
    cwd: repositoryRoot,
    encoding: "utf-8",
    timeout: budgetMs,
  });
  if (
    child.error !== undefined &&
    "code" in child.error &&
    child.error.code === "ETIMEDOUT"
  ) {
    return [`Source-write census exceeded budget ${budgetMs / 1000}s`];
  }
  if (child.status !== 0) {
    const detail =
      child.error?.message ||
      child.stderr ||
      child.stdout ||
      `exit ${child.status}, signal ${child.signal}`;
    return [`Source-write census failed: ${detail}`];
  }
  return [];
};

if (import.meta.main) {
  const files = filesToInspect(repositoryRoot);
  const violations = files.flatMap((file) =>
    inspectSourceWrites(
      readFileSync(path.join(repositoryRoot, file), "utf-8"),
      file,
    ),
  );
  const issues =
    files.length === 0
      ? ["Source-write census found no test files"]
      : sourceWriteExceptionIssues({
          root: repositoryRoot,
          observed: violations,
        });
  if (issues.length > 0) {
    process.stderr.write(issues.join("\n"));
    process.exitCode = 1;
  }
}
