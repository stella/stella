import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import type { IdentifierNode as Identifier } from "./syntax-estree-names";
import { type Node, parseSource, walk } from "./syntax-tree";
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

const createAnalysis = (file: string, source: string) => {
  const tree = parseSource(file, source);
  const parents = new Map<Node, Node>();
  walk(tree.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent) {
      parents.set(node, parent);
    }
  });
  const bindings = new Map<Node, Map<string, Node>>();
  const aliases = new Map<string, string>();
  walk(tree.program, (node, ancestors) => {
    if (node.type === "ImportSpecifier") {
      aliases.set(
        node.local.name,
        node.imported.type === "Identifier"
          ? node.imported.name
          : node.imported.value,
      );
    }
    if (
      node.type === "Property" &&
      !node.shorthand &&
      !node.computed &&
      ancestors.at(-1)?.type === "ObjectPattern" &&
      node.key.type === "Identifier"
    ) {
      const owner = ancestors.findLast(
        (ancestor) =>
          ![
            "ObjectPattern",
            "ArrayPattern",
            "Property",
            "AssignmentPattern",
            "RestElement",
          ].includes(ancestor.type),
      );
      const binding =
        node.value.type === "AssignmentPattern" ? node.value.left : node.value;
      if (
        owner?.type !== "AssignmentExpression" &&
        binding.type === "Identifier"
      ) {
        aliases.set(binding.name, node.key.name);
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init !== null
    ) {
      const scope = scopeOf({ node, parents, program: tree.program });
      let entries = bindings.get(scope);
      if (!entries) {
        entries = new Map();
        bindings.set(scope, entries);
      }
      entries.set(node.id.name, node.init);
    }
  });
  return { tree, parents, bindings, aliases };
};

type ScopeOfOptions = { node: Node; parents: Map<Node, Node>; program: Node };
type Analysis = ReturnType<typeof createAnalysis>;

const scopeOf = ({ node, parents, program }: ScopeOfOptions) => {
  let scope = parents.get(node);
  while (scope && scope.type !== "BlockStatement" && scope.type !== "Program") {
    scope = parents.get(scope);
  }
  return scope ?? program;
};

type BindingForOptions = {
  node: Identifier;
  parents: Map<Node, Node>;
  bindings: Map<Node, Map<string, Node>>;
};
const bindingFor = ({ node, parents, bindings }: BindingForOptions) => {
  let scope = parents.get(node);
  while (scope) {
    const initializer = bindings.get(scope)?.get(node.name);
    if (initializer !== undefined) {
      return initializer;
    }
    if (scope.type === "Program") {
      return undefined;
    }
    scope = parents.get(scope);
  }
  return undefined;
};

type CallNameOptions = {
  expression: Node;
  analysis: Analysis;
  seen?: Set<Node>;
};
const memberPropertyName = (expression: Node) => {
  if (expression.type !== "MemberExpression") {
    return undefined;
  }
  if (expression.computed) {
    if (
      expression.property.type === "Literal" &&
      typeof expression.property.value === "string"
    ) {
      return expression.property.value;
    }
    return undefined;
  }
  if (expression.property.type === "Identifier") {
    return expression.property.name;
  }
  return undefined;
};

const callName = ({
  expression,
  analysis,
  seen = new Set<Node>(),
}: CallNameOptions): string | undefined => {
  if (seen.has(expression)) {
    return undefined;
  }
  if (expression.type === "ChainExpression") {
    return callName({
      expression: expression.expression,
      analysis,
      seen: new Set(seen).add(expression),
    });
  }
  if (expression.type === "Identifier") {
    const initializer = bindingFor({
      node: expression,
      parents: analysis.parents,
      bindings: analysis.bindings,
    });
    if (initializer !== undefined) {
      return callName({
        expression: initializer,
        analysis,
        seen: new Set(seen).add(expression),
      });
    }
    return expression.name === "write" && !analysis.aliases.has(expression.name)
      ? undefined
      : (analysis.aliases.get(expression.name) ?? expression.name);
  }
  if (expression.type === "MemberExpression") {
    const property = memberPropertyName(expression);
    if (property === undefined) {
      return undefined;
    }
    if (
      property === "write" &&
      callName({
        expression: expression.object,
        analysis,
        seen: new Set(seen).add(expression),
      }) !== "Bun"
    ) {
      return undefined;
    }
    return property;
  }
  return undefined;
};

type EvaluatePathOptions = {
  node: Node;
  analysis: Analysis;
  absoluteFile: string;
  packageRoot: string;
  seen?: Set<Node>;
};

const evaluateUrlPath = ({
  node,
  analysis,
  absoluteFile,
  packageRoot,
  seen,
}: EvaluatePathOptions) => {
  if (node.type !== "NewExpression") {
    return undefined;
  }
  const relative = node.arguments.at(0);
  const base = node.arguments.at(1);
  const relativeValue =
    relative === undefined
      ? undefined
      : evaluatePath({
          node: relative,
          analysis,
          absoluteFile,
          packageRoot,
          seen,
        });
  const baseValue =
    base === undefined
      ? undefined
      : evaluatePath({
          node: base,
          analysis,
          absoluteFile,
          packageRoot,
          seen,
        });
  if (relativeValue !== undefined && baseValue?.startsWith("file://")) {
    return path.resolve(path.dirname(baseValue.slice(7)), relativeValue);
  }
  return undefined;
};

const evaluateCallPath = ({
  node,
  analysis,
  absoluteFile,
  packageRoot,
  seen,
}: EvaluatePathOptions) => {
  if (node.type !== "CallExpression") {
    return undefined;
  }
  const name = callName({ expression: node.callee, analysis });
  if (name === "tmpdir") {
    return "/__outside_repository_tmp__";
  }
  const values = node.arguments.map((argument) =>
    evaluatePath({ node: argument, analysis, absoluteFile, packageRoot, seen }),
  );
  if (name === "join" || name === "resolve") {
    if (values.every((value) => value === undefined)) {
      return undefined;
    }
    const segments = values.map((value) => value ?? "__dynamic__");
    if (name === "join") {
      return path.join(...segments);
    }
    return path.resolve(packageRoot, ...segments);
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

const evaluatePath = ({
  node,
  analysis,
  absoluteFile,
  packageRoot,
  seen = new Set<Node>(),
}: EvaluatePathOptions): string | undefined => {
  if (seen.has(node)) {
    return undefined;
  }
  const nextSeen = new Set(seen).add(node);
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "Identifier") {
    if (node.name === "__dirname") {
      return path.dirname(absoluteFile);
    }
    const initializer = bindingFor({
      node,
      parents: analysis.parents,
      bindings: analysis.bindings,
    });
    return initializer === undefined
      ? undefined
      : evaluatePath({
          node: initializer,
          analysis,
          absoluteFile,
          packageRoot,
          seen: nextSeen,
        });
  }
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.object.type === "MetaProperty"
  ) {
    if (node.property.name === "dir" || node.property.name === "dirname") {
      return path.dirname(absoluteFile);
    }
    if (node.property.name === "url") {
      return `file://${absoluteFile}`;
    }
  }
  if (node.type === "ChainExpression") {
    return evaluatePath({
      node: node.expression,
      analysis,
      absoluteFile,
      packageRoot,
      seen: nextSeen,
    });
  }
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return evaluatePath({
      node: node.expression,
      analysis,
      absoluteFile,
      packageRoot,
      seen: nextSeen,
    });
  }
  if (node.type === "AwaitExpression") {
    return evaluatePath({
      node: node.argument,
      analysis,
      absoluteFile,
      packageRoot,
      seen: nextSeen,
    });
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis
      .map((quasi, index) => {
        const text = quasi.value.cooked ?? quasi.value.raw;
        const expression = node.expressions.at(index);
        return expression
          ? `${text}${evaluatePath({ node: expression, analysis, absoluteFile, packageRoot, seen: nextSeen }) ?? "__dynamic__"}`
          : text;
      })
      .join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = evaluatePath({
      node: node.left,
      analysis,
      absoluteFile,
      packageRoot,
      seen: nextSeen,
    });
    const right = evaluatePath({
      node: node.right,
      analysis,
      absoluteFile,
      packageRoot,
      seen: nextSeen,
    });
    return left === undefined && right === undefined
      ? undefined
      : `${left ?? "__dynamic__"}${right ?? "__dynamic__"}`;
  }
  if (node.type === "NewExpression") {
    if (callName({ expression: node.callee, analysis }) === "URL") {
      return evaluateUrlPath({
        node,
        analysis,
        absoluteFile,
        packageRoot,
        seen: nextSeen,
      });
    }
    return undefined;
  }
  return evaluateCallPath({
    node,
    analysis,
    absoluteFile,
    packageRoot,
    seen: nextSeen,
  });
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
  const analysis = createAnalysis(file, source);
  walk(analysis.tree.program, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) {
      let scope = analysis.parents.get(node);
      while (
        scope &&
        scope.type !== "Program" &&
        !analysis.bindings.get(scope)?.has(node.left.name)
      ) {
        scope = analysis.parents.get(scope);
      }
      const targetScope =
        scope && analysis.bindings.get(scope)?.has(node.left.name)
          ? scope
          : scopeOf({
              node,
              parents: analysis.parents,
              program: analysis.tree.program,
            });
      let entries = analysis.bindings.get(targetScope);
      if (!entries) {
        entries = new Map();
        analysis.bindings.set(targetScope, entries);
      }
      entries.set(node.left.name, node.right);
    }
    const writer =
      node.type === "CallExpression"
        ? callName({ expression: node.callee, analysis })
        : undefined;
    const argumentIndexes =
      writer === undefined ? undefined : writers.get(writer);
    if (
      node.type !== "CallExpression" ||
      writer === undefined ||
      argumentIndexes === undefined
    ) {
      return;
    }
    for (const argumentIndex of argumentIndexes) {
      const destination = node.arguments.at(argumentIndex);
      const value =
        destination === undefined
          ? undefined
          : evaluatePath({
              node: destination,
              analysis,
              absoluteFile,
              packageRoot,
            });
      if (value === undefined) {
        continue;
      }
      const base = /^(?:apps|packages)\//u.test(value)
        ? repositoryRoot
        : packageRoot;
      const relative = repoRelativePath(
        repositoryRoot,
        path.resolve(base, value),
      );
      if (/^(?:apps|packages)\/[^/]+\/src(?:\/|$)/u.test(relative)) {
        violations.push(
          `${file}:${analysis.tree.locate(node.start).line}: ${writer} writes into src (${relative})`,
        );
      }
    }
  });
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

type RunSourceWriteCensusOptions = { budgetMs: number; entrypoint?: string };
export const runSourceWriteCensus = ({
  budgetMs,
  entrypoint = import.meta.path,
}: RunSourceWriteCensusOptions) => {
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
    return [
      `Source-write census failed: ${child.error?.message || child.stderr || child.stdout || `exit ${child.status ?? "none"}, signal ${child.signal ?? "none"}`}`,
    ];
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
