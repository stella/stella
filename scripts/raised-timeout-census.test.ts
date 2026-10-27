import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type Argument,
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { readCiCheckCommandText } from "./ci-check-pool-registry";
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

const timeoutInObject = (
  node: Node | Argument | undefined,
): number | undefined => {
  if (node?.type !== "ObjectExpression") {
    return undefined;
  }
  for (const property of node.properties) {
    if (property.type === "Property" && propertyName(property) === "timeout") {
      return numericValue(property.value);
    }
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
};

const bunTestBindings = (program: Node): BunTestBindings => {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  if (program.type !== "Program") {
    return { named, namespaces };
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
      if (
        imported !== undefined &&
        (TEST_CALLS.has(imported) || imported === "setDefaultTimeout")
      ) {
        named.set(specifier.local.name, imported);
      }
    }
  }
  return { named, namespaces };
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
  { named, namespaces }: BunTestBindings,
): string | undefined => {
  const chain = calleePath(callee);
  const root = chain?.at(0);
  if (chain === undefined || root === undefined) {
    return undefined;
  }
  const namedApi = named.get(root);
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

export const raisedTimeoutViolations = (
  file: string,
  source: string,
): Violation[] => {
  const parsed = parseSource(file, source);
  const bindings = bunTestBindings(parsed.program);
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
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const name = bunTestApi(node.callee, bindings);
    if (name === undefined) {
      return;
    }
    const args = node.arguments;
    let raised: number | undefined;
    if (name === "setDefaultTimeout") {
      raised = numericValue(args.at(0));
    } else if (TEST_CALLS.has(name)) {
      const timeout = args.at(HOOK_CALLS.has(name) ? 1 : 2);
      raised = numericValue(timeout) ?? timeoutInObject(timeout);
    }
    if (raised !== undefined && raised > DEFAULT_TIMEOUT_MS) {
      violations.push({
        line: parsed.locate(node.start).line,
        kind: `${name} timeout ${raised}`,
      });
    }
  });
  return violations;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
export const invalidDepthTestEntries = (
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
