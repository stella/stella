import { readFile } from "node:fs/promises";

const TEST_GLOB = "apps/api/**/*.test.ts";
const TIMEOUT_PROPERTY = /\btimeoutMs\s*:\s*([^,\n}]+)/gu;
const SHORT_TIMEOUT_MAX_MS = 2000;
const TIMEOUT_MARKER = "// timeout under test";

export const findApiTestTimeoutViolations = (
  source: string,
  path = "fixture.test.ts",
) => {
  const violations: string[] = [];
  for (const match of source.matchAll(TIMEOUT_PROPERTY)) {
    const expression = match[1]?.trim() ?? "";
    if (expression === "HAPPY_PATH_TIMEOUT_MS") {
      continue;
    }

    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index);
    const line = source.slice(
      lineStart,
      lineEnd === -1 ? source.length : lineEnd,
    );
    // A bare identifier bound in this file to a literal is judged by that
    // literal, so a short deadline cannot hide behind a local constant.
    const resolved = /^[A-Za-z_$][\w$]*$/u.test(expression)
      ? (new RegExp(
          `\\bconst\\s+${expression.replaceAll("$", "\\$")}\\s*(?::[^=]+)?=\\s*([0-9][0-9_]*)\\s*;`,
          "u",
        ).exec(source)?.[1] ?? expression)
      : expression;
    const numericLiteral = /^[0-9][0-9_]*$/u.test(resolved)
      ? Number(resolved.replaceAll("_", ""))
      : null;
    const isShortLiteral =
      numericLiteral !== null && numericLiteral <= SHORT_TIMEOUT_MAX_MS;
    const isUnparsableNumericExpression =
      numericLiteral === null && /^[0-9]/u.test(expression);

    if (
      (isShortLiteral || isUnparsableNumericExpression) &&
      !line.includes(TIMEOUT_MARKER)
    ) {
      const lineNumber = source.slice(0, lineStart).split("\n").length;
      violations.push(
        `${path}:${lineNumber}: use HAPPY_PATH_TIMEOUT_MS or mark a deterministic timeout with ${TIMEOUT_MARKER}`,
      );
    }
  }
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
