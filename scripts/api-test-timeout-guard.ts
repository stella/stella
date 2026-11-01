import { readFile } from "node:fs/promises";

import {
  type Expression,
  type ObjectPropertyKind,
  parseSource,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";

const TEST_GLOB = "apps/api/**/*.test.ts";
const SHORT_TIMEOUT_MAX_MS = 2000;
// A deadline the test exercises, or any other unproven value with its reason
// (forwarded from a caller, asserted rather than awaited, production value
// under a fake clock).
const TIMEOUT_MARKER = /\/\/ timeout(?: under test|: \S)/u;
const SHARED_DEADLINE = "HAPPY_PATH_TIMEOUT_MS";

const unwrap = (expression: Expression): Expression =>
  expression.type === "ParenthesizedExpression" ||
  expression.type === "TSAsExpression" ||
  expression.type === "TSSatisfiesExpression" ||
  expression.type === "TSTypeAssertion"
    ? unwrap(expression.expression)
    : expression;

const constLiterals = (file: Program) => {
  const bindings = new Map<string, Expression>();
  walk(file, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") {
      return;
    }
    for (const declaration of node.declarations) {
      if (declaration.id.type === "Identifier" && declaration.init) {
        bindings.set(declaration.id.name, declaration.init);
      }
    }
  });
  return bindings;
};

/**
 * The deadline in milliseconds when it is statically provable: a numeric
 * literal, or a same-file `const` that resolves to one. Everything else
 * (arithmetic, ternaries, imports, members, `let`, parameters) is unproven.
 */
const provenMilliseconds = (
  expression: Expression,
  bindings: ReadonlyMap<string, Expression>,
  seen = new Set<string>(),
): number | null => {
  const value = unwrap(expression);
  if (value.type === "Literal" && typeof value.value === "number") {
    return value.value;
  }
  if (value.type === "Identifier" && !seen.has(value.name)) {
    const bound = bindings.get(value.name);
    return bound === undefined
      ? null
      : provenMilliseconds(bound, bindings, new Set([...seen, value.name]));
  }
  return null;
};

/** The value an object literal gives `timeoutMs`; shorthand reads the binding. */
const timeoutValue = (node: ObjectPropertyKind): Expression | undefined => {
  if (
    node.type === "Property" &&
    !node.computed &&
    node.kind === "init" &&
    !node.method &&
    ((node.key.type === "Identifier" && node.key.name === "timeoutMs") ||
      (node.key.type === "Literal" && node.key.value === "timeoutMs"))
  ) {
    return node.value;
  }
  return undefined;
};

/**
 * Fail closed: every `timeoutMs` an API test passes is a violation unless it
 * is the shared happy-path deadline, is provably longer than a short deadline,
 * or its line carries a marker: the deadline is what the test exercises, or
 * a stated reason the value is not a happy-path wall-clock deadline.
 */
export const findApiTestTimeoutViolations = (
  source: string,
  path = "fixture.test.ts",
) => {
  const parsed = parseSource(path, source);
  const bindings = constLiterals(parsed.program);
  const lines = source.split("\n");
  const violations: string[] = [];
  walk(parsed.program, (node) => {
    if (node.type !== "ObjectExpression") {
      return;
    }
    for (const property of node.properties) {
      const value = timeoutValue(property);
      if (value === undefined) {
        continue;
      }
      const { line } = parsed.locate(property.start);
      const unwrapped = unwrap(value);
      const shared =
        unwrapped.type === "Identifier" && unwrapped.name === SHARED_DEADLINE;
      const proven = provenMilliseconds(value, bindings);
      const long = proven !== null && proven > SHORT_TIMEOUT_MAX_MS;
      if (!shared && !long && !TIMEOUT_MARKER.test(lines[line - 1] ?? "")) {
        violations.push(
          `${path}:${line}: use ${SHARED_DEADLINE}, a deadline provably over ${SHORT_TIMEOUT_MAX_MS} ms, or mark the line "// timeout under test" or "// timeout: <reason>"`,
        );
      }
    }
  });
  return violations;
};

export const scanApiTestTimeouts = async () => {
  const violations: string[] = [];
  const glob = new Bun.Glob(TEST_GLOB);
  for await (const path of glob.scan({ cwd: ".", onlyFiles: true })) {
    violations.push(
      ...findApiTestTimeoutViolations(await readFile(path, "utf-8"), path),
    );
  }
  return violations;
};

if (import.meta.main) {
  const violations = await scanApiTestTimeouts();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("API test timeout guard passed");
}
