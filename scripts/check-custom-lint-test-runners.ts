import { readFileSync } from "node:fs";
import path from "node:path";
import parse from "shell-quote/parse";

import {
  type CallExpression,
  type Node,
  parseSource,
  type StringLiteral,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";
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

const isStringLiteral = (node: Node): node is StringLiteral =>
  node.type === "Literal" && typeof node.value === "string";

const rawSpawnTest = (source: string): boolean => {
  if (!source.includes(TEST_PATH)) {
    return false;
  }
  const { program } = parseSource("runner.ts", source);
  const bindings = new Map<string, Node>();
  walk(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init !== null
    ) {
      bindings.set(node.id.name, node.init);
    }
  });
  const resolve = (node: Node, seen = new Set<string>()): Node => {
    if (node.type !== "Identifier" || seen.has(node.name)) {
      return node;
    }
    seen.add(node.name);
    const bound = bindings.get(node.name);
    return bound === undefined ? node : resolve(bound, seen);
  };
  const spawnsTest = (node: CallExpression): boolean => {
    const { callee } = node;
    const name =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier"
        ? callee.property.name
        : source.slice(callee.start, callee.end);
    const first = node.arguments.at(0);
    if (!SPAWN_APIS.has(name) || first === undefined) {
      return false;
    }
    const command = resolve(first);
    if (isStringLiteral(command) && rawShellTest(command.value)) {
      return true;
    }
    const arrays = [command, node.arguments.at(1)]
      .filter((argument) => argument !== undefined)
      .map((argument) => resolve(argument));
    if (command.type === "ObjectExpression") {
      for (const property of command.properties) {
        if (
          property.type === "Property" &&
          property.kind === "init" &&
          !property.method &&
          !property.shorthand &&
          !property.computed &&
          ((property.key.type === "Identifier" &&
            property.key.name === "cmd") ||
            (isStringLiteral(property.key) && property.key.value === "cmd"))
        ) {
          arrays.push(resolve(property.value));
        }
      }
    }
    return arrays.some((array) => {
      if (array.type !== "ArrayExpression") {
        return false;
      }
      const words = array.elements
        .filter((element) => element !== null)
        .map((element) => resolve(element))
        .filter(isStringLiteral)
        .map(({ value }) => value);
      return (
        words.includes("test") && words.some((word) => word.includes(TEST_PATH))
      );
    });
  };
  let found = false;
  walk(program, (node) => {
    if (found) {
      return "skip-children";
    }
    if (node.type === "CallExpression" && spawnsTest(node)) {
      found = true;
    }
    return undefined;
  });
  return found;
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
