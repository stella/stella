import { readFileSync } from "node:fs";
import path from "node:path";
import parse from "shell-quote/parse";
import ts from "typescript6";

import { isRecord, repoRoot, trackedRepoFiles } from "./oxlint-config-scopes";
import { flattenWorkflowSteps } from "./workflow-steps";

const TEST_PATH = ".oxlint-plugins/__tests__";
const SPAWN_APIS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);

const rawShellTest = (source: string): boolean =>
  source.includes(TEST_PATH) &&
  source
    .replace(/\\\r?\n/gu, " ")
    .split("\n")
    .some((line) => {
      const tokens = parse(line, (name) => `$${name}`);
      const words = tokens.map((token) => {
        if (typeof token === "string") {
          return token;
        }
        return "op" in token && token.op === "glob" ? token.pattern : "";
      });
      if (!words.some((word) => word.includes(TEST_PATH))) {
        return false;
      }
      return words.some(
        (word, index) =>
          path.basename(word) === "bun" &&
          (words.at(index + 1) === "test" ||
            (words.at(index + 1) === "--bun" &&
              words.at(index + 2) === "test")),
      );
    });

const rawSpawnTest = (source: string): boolean => {
  if (!source.includes(TEST_PATH)) {
    return false;
  }
  const file = ts.createSourceFile(
    "runner.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const resolve = (
    node: ts.Expression,
    seen = new Set<string>(),
  ): ts.Expression => {
    if (!ts.isIdentifier(node) || seen.has(node.text)) {
      return node;
    }
    seen.add(node.text);
    const bound = bindings.get(node.text);
    return bound === undefined ? node : resolve(bound, seen);
  };
  const visit = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(file);
      const first = node.arguments.at(0);
      if (SPAWN_APIS.has(name) && first !== undefined) {
        const command = resolve(first);
        if (ts.isStringLiteral(command) && rawShellTest(command.text)) {
          return true;
        }
        const arrays = [command, node.arguments.at(1)]
          .filter((argument) => argument !== undefined)
          .map((argument) => resolve(argument));
        if (ts.isObjectLiteralExpression(command)) {
          for (const property of command.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)) &&
              property.name.text === "cmd"
            ) {
              arrays.push(resolve(property.initializer));
            }
          }
        }
        for (const array of arrays) {
          if (!ts.isArrayLiteralExpression(array)) {
            continue;
          }
          const words = array.elements
            .map((element) => resolve(element))
            .filter(ts.isStringLiteral)
            .map(({ text }) => text);
          if (
            words.includes("test") &&
            words.some((word) => word.includes(TEST_PATH))
          ) {
            return true;
          }
        }
      }
    }
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(file);
};

export const customLintRunnerViolations = (
  filename: string,
  source: string,
): string[] => {
  const violates = (() => {
    if (filename.endsWith(".ts")) {
      return rawSpawnTest(source);
    }
    if (filename.endsWith("package.json")) {
      const manifest: unknown = JSON.parse(source);
      const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
      return (
        isRecord(scripts) &&
        Object.values(scripts).some(
          (command) => typeof command === "string" && rawShellTest(command),
        )
      );
    }
    if (filename.endsWith(".yml") || filename.endsWith(".yaml")) {
      const workflow: unknown = Bun.YAML.parse(source);
      const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
      return (
        isRecord(jobs) &&
        Object.values(jobs).some(
          (job) =>
            isRecord(job) &&
            job["steps"] !== undefined &&
            flattenWorkflowSteps(job["steps"]).some(
              (step) =>
                typeof step["run"] === "string" && rawShellTest(step["run"]),
            ),
        )
      );
    }
    return rawShellTest(source);
  })();
  return violates
    ? [
        `${filename}: run custom lint tests through scripts/run-custom-lint-tests.ts`,
      ]
    : [];
};

export const repositoryCustomLintRunnerViolations = (): string[] =>
  trackedRepoFiles()
    .filter(
      (filename) =>
        filename.endsWith("package.json") ||
        (filename.startsWith(".github/") && /\.ya?ml$/u.test(filename)) ||
        (/^(?:scripts\/|(?:apps|packages)\/[^/]+\/scripts\/)/u.test(filename) &&
          /\.(?:sh|ts)$/u.test(filename) &&
          !filename.endsWith(".test.ts")),
    )
    .flatMap((filename) =>
      customLintRunnerViolations(
        filename,
        readFileSync(path.join(repoRoot, filename), "utf-8"),
      ),
    );
