import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { type Identifier, type Node, parseSource, walk } from "./syntax-tree";
import {
  sourceWriteExceptionIssues,
  validateSourceWriteExceptions,
} from "./test-source-write-exceptions";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const writers = new Map([
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

const inspectSourceWrites = (source: string, file: string) => {
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
  const scopeOf = (node: Node): Node => {
    let scope = parents.get(node);
    while (
      scope &&
      scope.type !== "BlockStatement" &&
      scope.type !== "Program"
    ) {
      scope = parents.get(scope);
    }
    return scope ?? tree.program;
  };
  const collect = (node: Node, ancestors: readonly Node[]) => {
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
      const binding =
        node.value.type === "AssignmentPattern" ? node.value.left : node.value;
      if (binding.type === "Identifier") {
        aliases.set(binding.name, node.key.name);
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init !== null
    ) {
      const scope = scopeOf(node);
      let entries = bindings.get(scope);
      if (entries === undefined) {
        entries = new Map();
        bindings.set(scope, entries);
      }
      entries.set(node.id.name, node.init);
    }
  };
  walk(tree.program, collect);
  const bindingFor = (node: Identifier) => {
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
  const callName = (
    expression: Node,
    seen = new Set<Node>(),
  ): string | undefined => {
    if (seen.has(expression)) {
      return undefined;
    }
    if (expression.type === "Identifier") {
      const initializer = bindingFor(expression);
      if (initializer !== undefined) {
        return callName(initializer, new Set(seen).add(expression));
      }
      return expression.name === "write" && !aliases.has(expression.name)
        ? undefined
        : (aliases.get(expression.name) ?? expression.name);
    }
    if (
      expression.type === "MemberExpression" &&
      !expression.computed &&
      expression.property.type === "Identifier"
    ) {
      if (
        expression.property.name === "write" &&
        callName(expression.object, new Set(seen).add(expression)) !== "Bun"
      ) {
        return undefined;
      }
      return expression.property.name;
    }
    if (
      expression.type === "MemberExpression" &&
      expression.computed &&
      expression.property.type === "Literal" &&
      typeof expression.property.value === "string"
    ) {
      if (
        expression.property.value === "write" &&
        callName(expression.object, new Set(seen).add(expression)) !== "Bun"
      ) {
        return undefined;
      }
      return expression.property.value;
    }
    return undefined;
  };
  const evaluatePath = (
    node: Node,
    seen = new Set<Node>(),
  ): string | undefined => {
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
      const initializer = bindingFor(node);
      return initializer === undefined
        ? undefined
        : evaluatePath(initializer, nextSeen);
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
    if (
      node.type === "ParenthesizedExpression" ||
      node.type === "AwaitExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSNonNullExpression"
    ) {
      return evaluatePath(
        node.type === "AwaitExpression" ? node.argument : node.expression,
        nextSeen,
      );
    }
    if (node.type === "TemplateLiteral") {
      return node.quasis
        .map((quasi, index) => {
          const text = quasi.value.cooked ?? quasi.value.raw;
          const expression = node.expressions.at(index);
          return expression
            ? `${text}${evaluatePath(expression, nextSeen) ?? "__dynamic__"}`
            : text;
        })
        .join("");
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = evaluatePath(node.left, nextSeen);
      const right = evaluatePath(node.right, nextSeen);
      return left === undefined && right === undefined
        ? undefined
        : `${left ?? "__dynamic__"}${right ?? "__dynamic__"}`;
    }
    if (node.type === "NewExpression" && callName(node.callee) === "URL") {
      const relative = node.arguments.at(0);
      const base = node.arguments.at(1);
      const relativeValue =
        relative === undefined ? undefined : evaluatePath(relative, nextSeen);
      const baseValue =
        base === undefined ? undefined : evaluatePath(base, nextSeen);
      if (relativeValue !== undefined && baseValue?.startsWith("file://")) {
        return path.resolve(path.dirname(baseValue.slice(7)), relativeValue);
      }
    }
    if (node.type !== "CallExpression") {
      return undefined;
    }
    const name = callName(node.callee);
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
  const visit = (node: Node) => {
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) {
      let scope = parents.get(node);
      while (
        scope &&
        scope.type !== "Program" &&
        !bindings.get(scope)?.has(node.left.name)
      ) {
        scope = parents.get(scope);
      }
      const targetScope =
        scope && bindings.get(scope)?.has(node.left.name)
          ? scope
          : scopeOf(node);
      let entries = bindings.get(targetScope);
      if (entries === undefined) {
        entries = new Map();
        bindings.set(targetScope, entries);
      }
      entries.set(node.left.name, node.right);
    }
    const writer =
      node.type === "CallExpression" ? callName(node.callee) : undefined;
    const argumentIndexes =
      writer === undefined ? undefined : writers.get(writer);
    if (
      node.type === "CallExpression" &&
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
            const { line } = tree.locate(node.start);
            violations.push(
              `${file}:${line}: ${writer} writes into src (${relative})`,
            );
          }
        }
      }
    }
  };
  walk(tree.program, visit);
  return violations;
};

const filesToInspect = (root: string) =>
  [
    ...new Bun.Glob(
      "{apps,packages}/*/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    ).scanSync({ cwd: root, onlyFiles: true }),
  ].filter(
    (file) =>
      /\.(?:test|spec|test-helpers|test-fixtures)\.[cm]?[jt]sx?$/u.test(file) ||
      /\/(?:tests|__tests__|test-helpers|test-fixtures)\//u.test(file),
  );

// The complete source census exceeds Bun's unit-test budget; each Git child
// has its own deadline and is reaped before this outer deadline.
const SOURCE_CENSUS_TIMEOUT_MS = 30_000;

test(
  "tests keep generated files outside application and package source trees",
  () => {
    const files = filesToInspect(repositoryRoot);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      inspectSourceWrites(
        readFileSync(path.join(repositoryRoot, file), "utf-8"),
        file,
      ),
    );
    expect(
      sourceWriteExceptionIssues({
        root: repositoryRoot,
        observed: violations,
      }),
    ).toEqual([]);
  },
  SOURCE_CENSUS_TIMEOUT_MS,
);

test("ledger failures report termination even when Git emits no stderr", () => {
  for (const command of ["merge-base", "ls-tree", "show"]) {
    for (const termination of [
      { status: 1, signal: null, stderr: "" },
      { status: null, signal: "SIGKILL", stderr: "" },
      { status: 128, signal: null, stderr: "fatal: unavailable revision" },
      { status: 0, signal: "SIGTERM", stderr: "" },
    ] as const) {
      const issues = sourceWriteExceptionIssues({
        root: repositoryRoot,
        observed: [],
        git: (args) =>
          args.at(0) === command
            ? { ...termination, stdout: "" }
            : { status: 0, signal: null, stdout: "fixture", stderr: "" },
      });
      expect(issues).toHaveLength(1);
      expect(issues.at(0)).toContain(
        `exit status ${String(termination.status)}, signal ${String(termination.signal)}`,
      );
      expect(issues.at(0)).toContain(
        termination.stderr || "git produced no diagnostic",
      );
    }
  }
});

test("ledger failures preserve a Git spawn error", () => {
  const issues = sourceWriteExceptionIssues({
    root: repositoryRoot,
    observed: [],
    git: () => ({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      error: new Error("spawnSync git ETIMEDOUT"),
    }),
  });
  expect(issues).toEqual([
    "Source-write ledger merge base unavailable: exit status null, signal SIGKILL; spawnSync git ETIMEDOUT",
  ]);
});

test("ledger loading preserves the first rollout and shrink-only comparison", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-source-write-ledger-"));
  const exception = {
    source: "packages/example/src/example.test.ts",
    operation: "writeFileSync",
    destination: "packages/example/src/baseline.json",
    reason: "Explicit regeneration of a committed baseline.",
  };
  const current = JSON.stringify([exception]);
  const observed = [
    `${exception.source}:12: ${exception.operation} writes into src (${exception.destination})`,
  ];
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/test-source-write-exceptions.json"),
      current,
    );
    for (const baseline of [null, current, "[]"]) {
      const issues = sourceWriteExceptionIssues({
        root,
        observed,
        git: (args) => {
          let stdout = "fixture-revision";
          if (args.at(0) === "ls-tree") {
            stdout = baseline === null ? "" : "ledger";
          }
          if (args.at(0) === "show") {
            stdout = baseline ?? "";
          }
          return { status: 0, signal: null, stderr: "", stdout };
        },
      });
      expect(issues).toEqual(
        baseline === "[]"
          ? [
              `Source-write exceptions may only shrink: ${exception.source}: ${exception.operation} writes into src (${exception.destination})`,
            ]
          : [],
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the census inspects test helper directories and fixture modules", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-source-write-census-"));
  const helperFiles = [
    "apps/example/src/tests/helpers/source-mutant.ts",
    "apps/example/src/nested/__tests__/source-mutant.ts",
    "packages/example/src/test-helpers/source-mutant.ts",
    "packages/example/src/nested/test-fixtures/source-mutant.ts",
    "packages/example/src/source.test-helpers.ts",
    "apps/example/src/source.test-fixtures.ts",
    "packages/example/src/source.spec.mts",
  ];
  const excludedFiles = [
    "apps/example/src/helpers/production.ts",
    "packages/example/src/production.ts",
    "apps/example/scripts/outside.test.ts",
  ];
  const source = 'writeFileSync(path.join(import.meta.dir, "mutant.ts"), "");';
  try {
    for (const file of [...helperFiles, ...excludedFiles]) {
      const absoluteFile = path.join(root, file);
      mkdirSync(path.dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, source);
    }
    const selected = filesToInspect(root);
    expect(selected.toSorted()).toEqual(helperFiles.toSorted());
    const violations = selected.flatMap((file) =>
      inspectSourceWrites(readFileSync(path.join(root, file), "utf-8"), file),
    );
    expect(violations).toHaveLength(helperFiles.length);
    for (const file of helperFiles) {
      expect(
        violations.some((violation) => violation.startsWith(`${file}:`)),
        file,
      ).toBe(true);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("source-write exceptions exactly match observed writes and may only shrink", () => {
  const exception = {
    source: "apps/example/src/example.test.ts",
    operation: "writeFileSync",
    destination: "apps/example/src/baseline.json",
    reason: "Explicit regeneration of a committed baseline.",
  };
  const violation = `${exception.source}:12: ${exception.operation} writes into src (${exception.destination})`;
  const current = JSON.stringify([exception]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation],
      current,
      baseline: current,
    }),
  ).toEqual([]);
  expect(
    validateSourceWriteExceptions({
      observed: [],
      current: "[]",
      baseline: current,
    }),
  ).toEqual([]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation],
      current,
      baseline: "[]",
    }),
  ).toEqual([
    expect.stringContaining("Source-write exceptions may only shrink:"),
  ]);
  expect(
    validateSourceWriteExceptions({ observed: [], current, baseline: current }),
  ).toEqual([
    expect.stringContaining(
      "Source-write exceptions must equal observed debt:",
    ),
  ]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation, violation],
      current,
      baseline: current,
    }),
  ).toEqual([
    expect.stringContaining(
      "Source-write exceptions must equal observed debt:",
    ),
  ]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation],
      current: JSON.stringify([{ ...exception, reason: "" }]),
      baseline: current,
    }),
  ).toContain(
    "Source-write exceptions require source, operation, destination, and a reason",
  );
});

test("only Bun.write is treated as the filesystem write API", () => {
  const destination = '"packages/scripts/src/file.ts"';
  expect(
    inspectSourceWrites(
      `const { write } = fixture(); write(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toEqual([]);
  expect(
    inspectSourceWrites(
      `fixture.write(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toEqual([]);
  expect(
    inspectSourceWrites(
      `Bun.write(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toHaveLength(1);
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
  for (const [writer, argumentIndexes] of writers) {
    for (const destination of destinations) {
      const arguments_ = ['"fixture"', '"fixture"'];
      for (const index of argumentIndexes) {
        arguments_[index] = "target";
      }
      const fixture = `const root = ${destination}; const target = root; ${writer === "write" ? "Bun.write" : writer}(${arguments_.join(", ")});`;
      expect(
        inspectSourceWrites(fixture, "apps/api/src/tests/example.test.ts"),
        fixture,
      ).toHaveLength(argumentIndexes.length);
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
  expect(
    inspectSourceWrites(
      'const identity = <T>(value: T) => value; writeFileSync(path.join(import.meta.dir, "mutant.ts"), "");',
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
