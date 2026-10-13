import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const writers = new Set([
  "writeFileSync",
  "writeFile",
  "write",
  "mkdirSync",
  "mkdtempSync",
]);

const inspectSourceWrites = (source: string, file: string) => {
  const violations: string[] = [];
  if (!/write|mkdir|mkdtemp|\\/u.test(source)) {
    return violations;
  }
  const absoluteFile = path.resolve(repositoryRoot, file);
  const packageRoot = path.resolve(
    repositoryRoot,
    file.split("/").slice(0, 2).join("/"),
  );
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
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
    let scope: ts.Node | undefined = node.parent;
    while (scope !== undefined) {
      const initializer = bindings.get(scope)?.get(node.text);
      if (initializer !== undefined) {
        return initializer;
      }
      scope = scope.parent;
    }
    return undefined;
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
      return aliases.get(expression.text) ?? expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return expression.name.text;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression)
    ) {
      return expression.argumentExpression.text;
    }
    return undefined;
  };
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
      const relative = node.arguments?.at(0);
      const base = node.arguments?.at(1);
      const relativeValue =
        relative === undefined ? undefined : evaluatePath(relative, nextSeen);
      const baseValue =
        base === undefined ? undefined : evaluatePath(base, nextSeen);
      if (relativeValue !== undefined && baseValue?.startsWith("file://")) {
        return path.resolve(path.dirname(baseValue.slice(7)), relativeValue);
      }
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
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      let scope: ts.Node | undefined = node.parent;
      while (scope !== undefined && !bindings.get(scope)?.has(node.left.text)) {
        scope = scope.parent;
      }
      const targetScope = scope ?? scopeOf(node);
      let entries = bindings.get(targetScope);
      if (entries === undefined) {
        entries = new Map();
        bindings.set(targetScope, entries);
      }
      entries.set(node.left.text, node.right);
    }
    if (
      ts.isCallExpression(node) &&
      writers.has(callName(node.expression) ?? "")
    ) {
      const destination = node.arguments.at(0);
      const value =
        destination === undefined ? undefined : evaluatePath(destination);
      if (value !== undefined) {
        const base = /^(?:apps|packages)\//u.test(value)
          ? repositoryRoot
          : packageRoot;
        const relative = path.relative(
          repositoryRoot,
          path.resolve(base, value),
        );
        if (/^(?:apps|packages)\/[^/]+\/src(?:\/|$)/u.test(relative)) {
          const { line } = tree.getLineAndCharacterOfPosition(
            node.getStart(tree),
          );
          violations.push(
            `${file}:${line + 1}: ${callName(node.expression)} writes into src`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
};

test("tests keep generated files outside application and package source trees", () => {
  const files = [
    ...new Bun.Glob(
      "{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    ).scanSync({ cwd: repositoryRoot, onlyFiles: true }),
  ];
  expect(files.length).toBeGreaterThan(0);
  const violations = files.flatMap((file) =>
    inspectSourceWrites(
      readFileSync(path.join(repositoryRoot, file), "utf-8"),
      file,
    ),
  );
  // No exceptions: source scanners must see a stable tree throughout a test run.
  expect(violations).toEqual([]);
});

test("the census rejects every writer through direct and derived source destinations", () => {
  const destinations = [
    'import.meta.dir + "/mutation.ts"',
    'path.join(__dirname, "mutation.ts")',
    'path.resolve(import.meta.dir, "nested", name)',
    'path.join("apps/api/src", name)',
    '"src/mutation.ts"',
    'new URL("./mutation.ts", import.meta.url)',
    "path.join(path.dirname(fileURLToPath(import.meta.url)), name)",
  ];
  for (const writer of writers) {
    for (const destination of destinations) {
      const fixture = `const root = ${destination}; const target = root; ${writer === "write" ? "Bun.write" : writer}(target, "fixture");`;
      expect(
        inspectSourceWrites(fixture, "apps/api/src/tests/example.test.ts"),
        fixture,
      ).toHaveLength(1);
    }
  }
  expect(
    inspectSourceWrites(
      'import { writeFileSync as save } from "node:fs"; save(path.join(import.meta.dir, "mutant.ts"), "");',
      "packages/scripts/src/example.test.ts",
    ),
  ).toHaveLength(1);
  expect(
    inspectSourceWrites(
      'const dir = mkdtempSync(path.join(import.meta.dir, ".mutants-")); writeFileSync(path.join(dir, "mutant.ts"), "");',
      "packages/scripts/src/example.test.ts",
    ),
  ).toHaveLength(2);
  expect(
    inspectSourceWrites(
      'let directory; directory = import.meta.dir; writeFileSync(path.join(directory, "mutant.ts"), "");',
      "apps/api/src/example.test.ts",
    ),
  ).toHaveLength(1);
  expect(
    inspectSourceWrites(
      'const save = Bun.write; save(path.join(import.meta.dirname, "mutant.ts"), "");',
      "apps/api/src/example.test.ts",
    ),
  ).toHaveLength(1);
});

test("the census accepts source-shaped fixtures in isolated roots and paths escaping src", () => {
  for (const destination of [
    'path.join(tmpdir(), "fixture/src/mutant.ts")',
    'path.join(import.meta.dir, "../.test-mutants/mutant.ts")',
    'path.resolve(import.meta.dir, "../../../.test-mutants/mutant.ts")',
    'path.join(path.resolve(import.meta.dir, "../../.."), ".test-mutants/mutant.ts")',
  ]) {
    const fixture = `const directory = mkdtempSync(${destination}); writeFileSync(path.join(directory, "src/mutant.ts"), "");`;
    expect(
      inspectSourceWrites(fixture, "apps/api/src/example.test.ts"),
      fixture,
    ).toEqual([]);
  }
  const shadowed =
    'const directory = import.meta.dir; test("isolated", () => { const directory = tmpdir(); writeFileSync(path.join(directory, "src/file.ts"), ""); });';
  expect(inspectSourceWrites(shadowed, "apps/api/src/example.test.ts")).toEqual(
    [],
  );
});
