import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import depthTestReasons from "./depth-script-tests.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_TEST_TIMEOUT_MS = 5000;
const TIMED_APIS = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "it",
  "setDefaultTimeout",
  "test",
]);

const numericValue = (node: Node | undefined): number | undefined =>
  node?.type === "Literal" && typeof node.value === "number"
    ? node.value
    : undefined;

const memberRoot = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression" || node.type === "CallExpression") {
    return memberRoot(
      node.type === "MemberExpression" ? node.object : node.callee,
    );
  }
  return undefined;
};

const memberTail = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "CallExpression") {
    return memberTail(node.callee);
  }
  if (node.type !== "MemberExpression" || node.computed) {
    return undefined;
  }
  return node.property.type === "Identifier" ? node.property.name : undefined;
};

const objectTimeout = (node: Node | undefined): number | undefined => {
  if (node?.type !== "ObjectExpression") {
    return undefined;
  }
  for (const property of node.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === "timeout"
    ) {
      return numericValue(property.value);
    }
  }
  return undefined;
};

export const raisedTimeoutViolations = (
  sources: Readonly<Record<string, string>>,
): string[] => {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const parsed = parseSource(file, source);
    for (const comment of parsed.comments) {
      if (comment.value.includes("timeout:")) {
        violations.push(
          `${file}:${parsed.locate(comment.start).line}: raised timeout reason`,
        );
      }
    }

    const bindings = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of parsed.program.body) {
      if (
        statement.type !== "ImportDeclaration" ||
        statement.source.value !== "bun:test"
      ) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local.name);
        } else if (specifier.type === "ImportSpecifier") {
          bindings.set(
            specifier.local.name,
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value,
          );
        }
      }
    }

    walk(parsed.program, (node) => {
      if (node.type !== "CallExpression") {
        return;
      }
      const root = memberRoot(node.callee);
      const tail = memberTail(node.callee);
      let api: string | undefined;
      if (root !== undefined) {
        api = namespaces.has(root) ? tail : bindings.get(root);
      }
      if (api === undefined || !TIMED_APIS.has(api)) {
        return;
      }
      const arguments_ = node.arguments.filter(
        (argument) => argument.type !== "SpreadElement",
      );
      const timeout =
        api === "setDefaultTimeout"
          ? numericValue(arguments_.at(0))
          : (numericValue(arguments_.at(-1)) ??
            objectTimeout(arguments_.at(-1)));
      if (timeout !== undefined && timeout > DEFAULT_TEST_TIMEOUT_MS) {
        violations.push(
          `${file}:${parsed.locate(node.start).line}: ${api} raises the timeout to ${String(timeout)} ms`,
        );
      }
    });
  }
  return violations.toSorted();
};

const fastSuiteSources = (): Record<string, string> => {
  const depth = new Set(Object.keys(depthTestReasons));
  const files = [
    ...new Bun.Glob("scripts/**/*.test.ts").scanSync({ cwd: REPO_ROOT }),
    ...new Bun.Glob("{apps,packages}/**/*.dom.test.{ts,tsx}").scanSync({
      cwd: REPO_ROOT,
    }),
  ].filter((file) => !depth.has(file));
  return Object.fromEntries(
    files.map((file) => [
      file,
      readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    ]),
  );
};

test("fast-suite tests keep Bun's default per-test budget", () => {
  expect(raisedTimeoutViolations(fastSuiteSources())).toEqual([]);
});

test("reports every raised-budget form while ignoring fixture strings", () => {
  const fixture = `
    import * as bt from "bun:test";
    import { beforeAll as setup, setDefaultTimeout, test as check } from "bun:test";
    // timeout: deliberate raised budget
    setDefaultTimeout(6_000);
    check("positional", () => {}, 7_000);
    bt.test("options", () => {}, { timeout: 8_000 });
    setup(() => {}, 9_000);
    const text = "// timeout: setDefaultTimeout(60_000); test('x', () => {}, 60_000)";
  `;
  const violations = raisedTimeoutViolations({ "fixture.test.ts": fixture });
  expect(violations).toHaveLength(5);
  expect(violations.join("\n")).toContain("raised timeout reason");
  expect(violations.join("\n")).toContain("setDefaultTimeout raises");
  expect(violations.join("\n")).toContain("test raises");
  expect(violations.join("\n")).toContain("beforeAll raises");
});

test("accepts default-or-lower budgets", () => {
  expect(
    raisedTimeoutViolations({
      "fixture.test.ts": `
        import { beforeEach, setDefaultTimeout, test } from "bun:test";
        setDefaultTimeout(5_000);
        test("positional", () => {}, 4_999);
        beforeEach(() => {}, { timeout: 5_000 });
      `,
    }),
  ).toEqual([]);
});
