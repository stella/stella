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

export const raisedTimeoutViolations = (
  file: string,
  source: string,
): Violation[] => {
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
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") {
      return;
    }
    const name = node.callee.name;
    const args = node.arguments;
    let raised: number | undefined;
    if (name === "setDefaultTimeout") {
      raised = numericValue(args.at(0));
    } else if (TEST_CALLS.has(name)) {
      raised = Math.max(
        numericValue(args.at(2)) ?? 0,
        timeoutInObject(args.at(1)) ?? 0,
        timeoutInObject(args.at(2)) ?? 0,
      );
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
const fastSuiteFiles = () => {
  const patterns = [
    "scripts/**/*.test.ts",
    "apps/**/*.dom.test.{ts,tsx}",
    "packages/**/*.dom.test.{ts,tsx}",
  ];
  const excluded = new Set(Object.keys(depthTests));
  const scriptTests = unlistedTests(
    [...new Bun.Glob("scripts/**/*.test.ts").scanSync({ cwd: repoRoot })],
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
      // timeout: slow fixture
      setDefaultTimeout(6_000);
      test("positional", () => {}, 7_000);
      beforeAll(() => {}, { timeout: 8_000 });
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
    ]);
  });

  test("ignores markers and calls inside string literals", () => {
    const source = `const fixture = "// timeout: fixture\\nsetDefaultTimeout(60_000)";`;
    expect(raisedTimeoutViolations("fixture.test.ts", source)).toEqual([]);
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
