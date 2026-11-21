import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type Argument,
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import {
  CHECK_POOL_JOBS,
  type PoolCheck,
  readCheckPool,
  readCiCheckCommandText,
} from "./ci-check-pool-registry";
import depthTests from "./depth-script-tests.json" with { type: "json" };
import { unlistedTests } from "./run-unlisted-script-tests";

const DEFAULT_TIMEOUT_MS = 5000;
const TEST_CALLS = new Set([
  "test",
  "it",
  "describe",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
]);
const HOOK_CALLS = new Set([
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
]);
const TEST_MODIFIERS = new Set([
  "each",
  "skip",
  "only",
  "todo",
  "if",
  "skipIf",
  "todoIf",
]);

type Violation = { readonly line: number; readonly kind: string };

const numericValue = (
  node: Node | Argument | undefined,
): number | undefined => {
  if (node?.type !== "Literal" || typeof node.value !== "number") {
    return undefined;
  }
  return node.value;
};

const propertyName = (node: Node): string | undefined => {
  if (node.type !== "Property" || node.computed) {
    return undefined;
  }
  if (node.key.type === "Identifier") {
    return node.key.name;
  }
  if (node.key.type === "Literal" && typeof node.key.value === "string") {
    return node.key.value;
  }
  return undefined;
};

const nodeName = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
};

type BunTestBindings = {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
  readonly jestObjects: ReadonlySet<string>;
};

const bunTestBindings = (program: Node): BunTestBindings => {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  const jestObjects = new Set(["jest"]);
  if (program.type !== "Program") {
    return { jestObjects, named, namespaces };
  }
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "bun:test"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(specifier.local.name);
        continue;
      }
      if (specifier.type !== "ImportSpecifier") {
        continue;
      }
      const imported = nodeName(specifier.imported);
      if (imported === "jest") {
        jestObjects.add(specifier.local.name);
        continue;
      }
      if (
        imported !== undefined &&
        (TEST_CALLS.has(imported) || imported === "setDefaultTimeout")
      ) {
        named.set(specifier.local.name, imported);
      }
    }
  }
  return { jestObjects, named, namespaces };
};

const calleePath = (callee: Node): string[] | undefined => {
  if (callee.type === "Identifier") {
    return [callee.name];
  }
  if (callee.type === "CallExpression") {
    return calleePath(callee.callee);
  }
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  if (
    callee.computed &&
    (callee.property.type !== "Literal" ||
      typeof callee.property.value !== "string")
  ) {
    return undefined;
  }
  const property = nodeName(callee.property);
  const chain = calleePath(callee.object);
  if (property === undefined || chain === undefined) {
    return undefined;
  }
  chain.push(property);
  return chain;
};

const bunTestApi = (
  callee: Node,
  { jestObjects, named, namespaces }: BunTestBindings,
): string | undefined => {
  const chain = calleePath(callee);
  const root = chain?.at(0);
  if (chain === undefined || root === undefined) {
    return undefined;
  }
  const namedApi = named.get(root);
  if (
    (jestObjects.has(root) &&
      chain.length === 2 &&
      chain.at(1) === "setTimeout") ||
    (namespaces.has(root) &&
      chain.length === 3 &&
      chain.at(1) === "jest" &&
      chain.at(2) === "setTimeout")
  ) {
    return "jest.setTimeout";
  }
  const api = namedApi ?? (namespaces.has(root) ? chain.at(1) : undefined);
  const modifiers = chain.slice(namedApi === undefined ? 2 : 1);
  if (
    api === undefined ||
    (!TEST_CALLS.has(api) && api !== "setDefaultTimeout") ||
    modifiers.some((modifier) => !TEST_MODIFIERS.has(modifier))
  ) {
    return undefined;
  }
  return api;
};

/**
 * A timeout a suite declares in source: a default setter's argument, or a
 * test or hook's own timeout. `value` is undefined when it is not a literal.
 */
type DeclaredTimeout = {
  readonly line: number;
  readonly name: string;
  readonly setter: boolean;
  readonly value: number | undefined;
};

/** Module-level `const NAME = <number>` bindings, the usual named budgets. */
const numericConstants = (program: Node): ReadonlyMap<string, number> => {
  const constants = new Map<string, number>();
  if (program.type !== "Program") {
    return constants;
  }
  for (const statement of program.body) {
    if (
      statement.type !== "VariableDeclaration" ||
      statement.kind !== "const"
    ) {
      continue;
    }
    for (const declarator of statement.declarations) {
      const value = numericValue(declarator.init ?? undefined);
      if (declarator.id.type === "Identifier" && value !== undefined) {
        constants.set(declarator.id.name, value);
      }
    }
  }
  return constants;
};

const declaredTimeouts = (
  parsed: ReturnType<typeof parseSource>,
): DeclaredTimeout[] => {
  const bindings = bunTestBindings(parsed.program);
  const constants = numericConstants(parsed.program);
  const timeoutOf = (node: Node | Argument | undefined): number | undefined => {
    if (node?.type === "Identifier") {
      return constants.get(node.name);
    }
    if (
      node?.type === "BinaryExpression" &&
      (node.operator === "+" || node.operator === "*")
    ) {
      const left = timeoutOf(node.left);
      const right = timeoutOf(node.right);
      if (left === undefined || right === undefined) {
        return undefined;
      }
      return node.operator === "+" ? left + right : left * right;
    }
    return numericValue(node);
  };
  const declared: DeclaredTimeout[] = [];
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const name = bunTestApi(node.callee, bindings);
    if (name === undefined) {
      return;
    }
    const line = parsed.locate(node.start).line;
    const args = node.arguments;
    if (name === "setDefaultTimeout" || name === "jest.setTimeout") {
      declared.push({
        line,
        name,
        setter: true,
        value: timeoutOf(args.at(0)),
      });
      return;
    }
    if (!TEST_CALLS.has(name)) {
      return;
    }
    const timeout = args.at(HOOK_CALLS.has(name) ? 1 : 2);
    let timeoutValue: Node | Argument | undefined = timeout;
    if (timeout?.type === "ObjectExpression") {
      const timeoutProperty = timeout.properties.find(
        (property) =>
          property.type === "Property" && propertyName(property) === "timeout",
      );
      timeoutValue =
        timeoutProperty?.type === "Property"
          ? timeoutProperty.value
          : undefined;
    }
    if (timeoutValue !== undefined) {
      declared.push({
        line,
        name,
        setter: false,
        value: timeoutOf(timeoutValue),
      });
    }
  });
  return declared;
};

const raisedTimeoutViolations = (file: string, source: string): Violation[] => {
  const parsed = parseSource(file, source);
  const violations: Violation[] = parsed.comments.flatMap((comment) =>
    /^\s*timeout:/u.test(comment.value)
      ? [
          {
            line: parsed.locate(comment.start).line,
            kind: "timeout reason comment",
          },
        ]
      : [],
  );
  for (const { line, name, setter, value } of declaredTimeouts(parsed)) {
    if (!setter && (value === undefined || value === 0)) {
      violations.push({
        line,
        kind: `${name} timeout ${value === 0 ? "0" : "non-literal"}`,
      });
    } else if (value !== undefined && value > DEFAULT_TIMEOUT_MS) {
      violations.push({ line, kind: `${name} timeout ${value}` });
    }
  }
  return violations;
};

/** A suite a pooled CI check runs under `bun test --timeout <budgetMs>`. */
type BudgetedSuite = {
  readonly check: string;
  readonly budgetMs: number;
  readonly file: string;
};

const budgetedSuites = (
  checks: readonly Pick<PoolCheck, "name" | "run">[],
  expand: (pattern: string) => readonly string[],
): BudgetedSuite[] =>
  checks.flatMap(({ name, run }) =>
    run
      .replaceAll("\\\n", " ")
      .split(/\n|&&|;/u)
      .flatMap((command) => {
        const words = command.trim().split(/\s+/u);
        const start = words.findIndex(
          (word, index) => word === "bun" && words[index + 1] === "test",
        );
        if (start === -1) {
          return [];
        }
        const args = words.slice(start + 2);
        let budgetMs: number | undefined;
        const files: string[] = [];
        for (const [index, arg] of args.entries()) {
          const inline = /^--timeout=(\d+)$/u.exec(arg);
          if (inline !== null) {
            budgetMs = Number(inline[1]);
          } else if (arg === "--timeout") {
            budgetMs = Number(args[index + 1]);
          } else if (/\.test\.tsx?$/u.test(arg)) {
            files.push(...expand(arg));
          }
        }
        return budgetMs === undefined
          ? []
          : files.map((file) => ({ check: name, budgetMs, file }));
      }),
  );

// A suite's own timeout replaces the runner's `--timeout` for that test, so a
// lower literal silently shrinks the budget the check measured for it.
const shadowedBudgetViolations = (
  file: string,
  source: string,
  budgetMs: number,
): Violation[] =>
  declaredTimeouts(parseSource(file, source)).flatMap(
    ({ line, name, value }) => {
      if (value === undefined) {
        return [{ line, kind: `${name} timeout non-literal` }];
      }
      return value !== 0 && value < budgetMs
        ? [{ line, kind: `${name} timeout ${value} below ${budgetMs}` }]
        : [];
    },
  );

const repoRoot = path.resolve(import.meta.dirname, "..");
const invalidDepthTestEntries = (
  entries: readonly string[],
  runnableScriptTests: readonly string[],
): string[] => {
  const runnable = new Set(runnableScriptTests);
  return entries.filter((entry) => !runnable.has(entry)).toSorted();
};

const scriptRunnerTestFiles = () => [
  ...new Bun.Glob("scripts/**/*.test.{ts,sh}").scanSync({ cwd: repoRoot }),
];

const fastSuiteFiles = () => {
  const patterns = [
    "scripts/**/*.test.ts",
    "apps/**/*.dom.test.{ts,tsx}",
    "packages/**/*.dom.test.{ts,tsx}",
  ];
  const excluded = new Set(Object.keys(depthTests));
  const scriptTests = unlistedTests(
    scriptRunnerTestFiles().filter((file) => file.endsWith(".ts")),
    readCiCheckCommandText(repoRoot),
  );
  const domTests = patterns
    .slice(1)
    .flatMap((pattern) => [
      ...new Bun.Glob(pattern).scanSync({ cwd: repoRoot }),
    ]);
  return [...scriptTests, ...domTests]
    .filter((file) => !excluded.has(file))
    .toSorted();
};

describe("raised timeout detector", () => {
  test("reports every raised-budget form", () => {
    const source = `
      import {
        afterAll,
        afterEach,
        beforeAll,
        beforeEach,
        describe,
        setDefaultTimeout,
        test,
      } from "bun:test";
      import * as bt from "bun:test";
      import { jest as runner } from "bun:test";
      // timeout: slow fixture
      setDefaultTimeout(6_000);
      test("positional", () => {}, 7_000);
      beforeAll(() => {}, 8_000);
      beforeEach(() => {}, { timeout: 9_000 });
      afterAll(() => {}, 10_000);
      afterEach(() => {}, { timeout: 11_000 });
      test.each([1])("each", () => {}, 12_000);
      test.skip("skip", () => {}, { timeout: 13_000 });
      test.if(true)("if", () => {}, 14_000);
      test.only("only", () => {}, 15_000);
      test.todo("todo", () => {}, 16_000);
      test.skipIf(true)("skipIf", () => {}, 17_000);
      test.todoIf(true)("todoIf", () => {}, 18_000);
      describe.each([1])("describe each", () => {}, 19_000);
      bt.test("namespace", () => {}, 20_000);
      jest.setTimeout(21_000);
      runner.setTimeout(22_000);
      bt.jest.setTimeout(23_000);
      test("disabled", () => {}, 0);
      test("dynamic", () => {}, timeoutBudget);
      test("dynamic object", () => {}, { timeout: getTimeout() });
    `;
    expect(
      raisedTimeoutViolations("fixture.test.ts", source).map(
        ({ kind }) => kind,
      ),
    ).toEqual([
      "timeout reason comment",
      "setDefaultTimeout timeout 6000",
      "test timeout 7000",
      "beforeAll timeout 8000",
      "beforeEach timeout 9000",
      "afterAll timeout 10000",
      "afterEach timeout 11000",
      "test timeout 12000",
      "test timeout 13000",
      "test timeout 14000",
      "test timeout 15000",
      "test timeout 16000",
      "test timeout 17000",
      "test timeout 18000",
      "describe timeout 19000",
      "test timeout 20000",
      "jest.setTimeout timeout 21000",
      "jest.setTimeout timeout 22000",
      "jest.setTimeout timeout 23000",
      "test timeout 0",
      "test timeout non-literal",
      "test timeout non-literal",
    ]);
  });

  test("accepts every supported form at the default budget", () => {
    const source = `
      import {
        afterAll,
        afterEach,
        beforeAll,
        beforeEach,
        describe,
        setDefaultTimeout,
        test,
      } from "bun:test";
      import * as bt from "bun:test";
      import { jest as runner } from "bun:test";
      setDefaultTimeout(5_000);
      test("positional", () => {}, 5_000);
      beforeAll(() => {}, 5_000);
      beforeEach(() => {}, { timeout: 5_000 });
      afterAll(() => {}, 5_000);
      afterEach(() => {}, { timeout: 5_000 });
      test.each([1])("each", () => {}, 5_000);
      test.skip("skip", () => {}, { timeout: 5_000 });
      test.if(true)("if", () => {}, 5_000);
      test.only("only", () => {}, 5_000);
      test.todo("todo", () => {}, 5_000);
      test.skipIf(true)("skipIf", () => {}, 5_000);
      test.todoIf(true)("todoIf", () => {}, 5_000);
      describe.each([1])("describe each", () => {}, 5_000);
      bt.test("namespace", () => {}, 5_000);
      jest.setTimeout(5_000);
      runner.setTimeout(5_000);
      bt.jest.setTimeout(5_000);
    `;
    expect(raisedTimeoutViolations("fixture.test.ts", source)).toEqual([]);
  });

  test("ignores markers and calls inside string literals", () => {
    const source = `const fixture = "// timeout: fixture\\nsetDefaultTimeout(60_000)";`;
    expect(raisedTimeoutViolations("fixture.test.ts", source)).toEqual([]);
  });
});

describe("depth-list scope", () => {
  test("reports entries outside the script runner", () => {
    expect(
      invalidDepthTestEntries(
        ["scripts/depth.test.ts", "apps/web/src/example.dom.test.tsx"],
        ["scripts/depth.test.ts"],
      ),
    ).toEqual(["apps/web/src/example.dom.test.tsx"]);
  });

  test("contains only files in the script runner's discovery scope", () => {
    expect(
      invalidDepthTestEntries(Object.keys(depthTests), scriptRunnerTestFiles()),
    ).toEqual([]);
  });
});

test("fast suites keep Bun's default per-test timeout", async () => {
  const failures: string[] = [];
  for (const file of fastSuiteFiles()) {
    const source = await Bun.file(path.join(repoRoot, file)).text();
    for (const violation of raisedTimeoutViolations(file, source)) {
      failures.push(`${file}:${violation.line}: ${violation.kind}`);
    }
  }
  expect(failures).toEqual([]);
});

describe("budgeted suite detector", () => {
  test("reads every bun test budget a check runs", () => {
    const checks = [
      {
        name: "folded",
        // YAML folds a `>-` block into one line.
        run: "bun test --timeout 12000 --preload ./setup.ts apps/api/scripts/*.test.ts",
      },
      {
        name: "chained",
        run: "bun test --timeout=5000 a.test.ts && bun run check:a\nbun test --timeout 400000 b.test.ts \\\n  c.test.tsx",
      },
      { name: "unbudgeted", run: "bun test d.test.ts" },
    ];
    expect(
      budgetedSuites(checks, (pattern) =>
        pattern.includes("*") ? ["apps/api/scripts/x.test.ts"] : [pattern],
      ),
    ).toEqual([
      { check: "folded", budgetMs: 12_000, file: "apps/api/scripts/x.test.ts" },
      { check: "chained", budgetMs: 5000, file: "a.test.ts" },
      { check: "chained", budgetMs: 400_000, file: "b.test.ts" },
      { check: "chained", budgetMs: 400_000, file: "c.test.tsx" },
    ]);
  });

  test("reports a suite timeout below its check's budget", () => {
    const source = `
      import { beforeAll, setDefaultTimeout, test } from "bun:test";
      const BASE = 10_000;
      setDefaultTimeout(60_000);
      beforeAll(() => {}, 400_000);
      test("lower", () => {}, 180_000);
      test("object", () => {}, { timeout: 90_000 });
      test("higher", () => {}, 600_000);
      test("dynamic", () => {}, budget);
      test("sum", () => {}, BASE + 2_000);
      test("disabled", () => {}, 0);
      test("runner budget", () => {});
    `;
    expect(
      shadowedBudgetViolations("fixture.test.ts", source, 400_000).map(
        (violation) => violation.kind,
      ),
    ).toEqual([
      "setDefaultTimeout timeout 60000 below 400000",
      "test timeout 180000 below 400000",
      "test timeout 90000 below 400000",
      "test timeout non-literal",
      "test timeout 12000 below 400000",
    ]);
  });
});

test("budgeted suites never shrink their check's budget", async () => {
  const expand = (pattern: string) =>
    pattern.includes("*")
      ? [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })]
      : [pattern];
  const suites = budgetedSuites(
    CHECK_POOL_JOBS.flatMap((job) => readCheckPool(job)),
    expand,
  );
  expect(
    suites.some(
      (suite) => suite.file === "scripts/capability-shard-merge.test.ts",
    ),
  ).toBe(true);
  const failures: string[] = [];
  for (const { check, budgetMs, file } of suites) {
    const source = await Bun.file(path.join(repoRoot, file)).text();
    for (const violation of shadowedBudgetViolations(file, source, budgetMs)) {
      failures.push(`${file}:${violation.line}: ${violation.kind} (${check})`);
    }
  }
  expect(failures).toEqual([]);
});
