import { readFile } from "node:fs/promises";
import ts from "typescript6";

const TEST_GLOB = "apps/api/**/*.test.ts";
const SHORT_TIMEOUT_MAX_MS = 2000;
// A deadline the test exercises, or any other unproven value with its reason
// (forwarded from a caller, asserted rather than awaited, production value
// under a fake clock).
const TIMEOUT_MARKER = /\/\/ timeout(?: under test|: \S)/u;
const SHARED_DEADLINE = "HAPPY_PATH_TIMEOUT_MS";

const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ||
  ts.isAsExpression(expression) ||
  ts.isSatisfiesExpression(expression) ||
  ts.isTypeAssertionExpression(expression)
    ? unwrap(expression.expression)
    : expression;

const constLiterals = (file: ts.SourceFile) => {
  const bindings = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      node.getFirstToken(file)?.kind === ts.SyntaxKind.ConstKeyword
    ) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
};

/**
 * The deadline in milliseconds when it is statically provable: a numeric
 * literal, or a same-file `const` that resolves to one. Everything else
 * (arithmetic, ternaries, imports, members, `let`, parameters) is unproven.
 */
const provenMilliseconds = (
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): number | null => {
  const value = unwrap(expression);
  if (ts.isNumericLiteral(value)) {
    return Number(value.text);
  }
  if (ts.isIdentifier(value) && !seen.has(value.text)) {
    const bound = bindings.get(value.text);
    return bound === undefined
      ? null
      : provenMilliseconds(bound, bindings, new Set([...seen, value.text]));
  }
  return null;
};

/** The value an object literal gives `timeoutMs`; shorthand reads the binding. */
const timeoutValue = (node: ts.Node): ts.Expression | undefined => {
  if (ts.isShorthandPropertyAssignment(node)) {
    return node.name.text === "timeoutMs" ? node.name : undefined;
  }
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    node.name.text === "timeoutMs"
  ) {
    return node.initializer;
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
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = constLiterals(file);
  const lines = source.split("\n");
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    const value = timeoutValue(node);
    if (value !== undefined) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      const unwrapped = unwrap(value);
      const shared =
        ts.isIdentifier(unwrapped) && unwrapped.text === SHARED_DEADLINE;
      const proven = provenMilliseconds(value, bindings);
      const long = proven !== null && proven > SHORT_TIMEOUT_MAX_MS;
      if (!shared && !long && !TIMEOUT_MARKER.test(lines[line] ?? "")) {
        violations.push(
          `${path}:${line + 1}: use ${SHARED_DEADLINE}, a deadline provably over ${SHORT_TIMEOUT_MAX_MS} ms, or mark the line "// timeout under test" or "// timeout: <reason>"`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
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
