import { eslintCompatPlugin } from "@oxlint/plugins";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type AstNode,
  isAstNode,
  isTestFile,
  repoRelativeFilename,
} from "./utils.ts";

/**
 * A run or batch that finishes when a count of its rows reaches the planned
 * number is only correct if every writer it counts commits in turn. Writers
 * that overlap each count without the other's uncommitted rows, so neither
 * finishes the run. PGlite has a single connection and can never overlap two
 * transactions, so the suites that cover such a function must include one on
 * real PostgreSQL that does.
 *
 * Each function in scope that reads an aggregate count and writes a terminal
 * status is listed here with that suite. A listed suite must exist and open
 * two clients through `withGatedTestClients`.
 */
const RULE_NAME = "count-gated-completion";
const FIXTURE_PATH =
  ".oxlint-plugins/__fixtures__/count-gated-completion.fixture.ts";
const SCOPE_PREFIXES = [
  "apps/api/src/lib/document-review/",
  "apps/api/src/lib/workflow/",
] as const;
const SCOPE_FILES = ["apps/api/src/lib/workflow-queue.ts"] as const;
const OVERLAP_HELPER = "withGatedTestClients";
const TERMINAL_STATUSES = new Set([
  "complete",
  "completed",
  "done",
  "finished",
  "succeeded",
]);

type Registration = {
  readonly file: string;
  readonly fn: string;
  readonly concurrencyTest: string;
};

export const COUNT_GATED_COMPLETIONS: readonly Registration[] = [
  {
    file: "apps/api/src/lib/document-review/run-finalize.ts",
    fn: "finalizeReviewRun",
    concurrencyTest:
      "apps/api/src/lib/document-review/table-run-findings.postgres.test.ts",
  },
];

const children = (node: AstNode): AstNode[] => {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          out.push(item);
        }
      }
    } else if (isAstNode(value)) {
      out.push(value);
    }
  }
  return out;
};

const identifierName = (node: unknown): string | null =>
  isAstNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;

const keyName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
};

const COUNT_IN_SQL = /\bcount\s*\(/iu;

/** `count()`, `countDistinct()`, `tx.$count()` or SQL text with `count(`. */
const isCountRead = (node: AstNode): boolean => {
  if (node.type === "CallExpression") {
    const callee = node.callee;
    const name = identifierName(callee);
    if (name === "count" || name === "countDistinct") {
      return true;
    }
    if (
      isAstNode(callee) &&
      callee.type === "MemberExpression" &&
      keyName(callee.property) === "$count"
    ) {
      return true;
    }
  }
  if (node.type === "TemplateElement") {
    const value = node.value;
    const raw =
      typeof value === "object" && value !== null && "raw" in value
        ? value.raw
        : undefined;
    return typeof raw === "string" && COUNT_IN_SQL.test(raw);
  }
  return false;
};

/** `status: "completed"` or `status: RUN_STATUS.COMPLETED` in an object. */
const isTerminalStatusWrite = (node: AstNode): boolean => {
  if (node.type !== "Property" || keyName(node.key) !== "status") {
    return false;
  }
  const value = node.value;
  if (!isAstNode(value)) {
    return false;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
    return TERMINAL_STATUSES.has(value.value.toLowerCase());
  }
  if (value.type === "MemberExpression") {
    const member = keyName(value.property);
    return member !== null && TERMINAL_STATUSES.has(member.toLowerCase());
  }
  return false;
};

type Unit = {
  name: string;
  line: number;
  counts: boolean;
  completes: boolean;
};

const isFunction = (node: AstNode) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";

/**
 * Named functions in the module whose bodies (callbacks included) both read a
 * count and write a terminal status. A callback belongs to the nearest named
 * function around it, which is the unit a reader of the code would name.
 */
export const countGatedFunctions = (
  program: unknown,
  lineOf: (offset: number) => number,
): { name: string; line: number }[] => {
  const units: Unit[] = [];
  const visit = (
    node: AstNode,
    unit: Unit | null,
    pendingName: string | null,
  ) => {
    let current = unit;
    if (isFunction(node)) {
      const declared = identifierName(node.id) ?? pendingName;
      if (declared !== null) {
        current = {
          name: declared,
          line: lineOf(typeof node.start === "number" ? node.start : 0),
          counts: false,
          completes: false,
        };
        units.push(current);
      }
    }
    if (current !== null) {
      if (isCountRead(node)) {
        current.counts = true;
      }
      if (isTerminalStatusWrite(node)) {
        current.completes = true;
      }
    }
    const nameForChild =
      node.type === "VariableDeclarator" ? identifierName(node.id) : null;
    for (const child of children(node)) {
      visit(
        child,
        current,
        nameForChild !== null && child === node.init ? nameForChild : null,
      );
    }
  };
  if (isAstNode(program)) {
    visit(program, null, null);
  }
  return units
    .filter((unit) => unit.counts && unit.completes)
    .map(({ name, line }) => ({ name, line }));
};

const inScope = (file: string) =>
  file === FIXTURE_PATH ||
  ((SCOPE_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    SCOPE_FILES.some((scoped) => file === scoped)) &&
    !isTestFile(file));

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

/** Why a registration's overlap suite does not qualify, or null. */
export const overlapProblem = (
  registration: Registration,
  root: string = REPOSITORY_ROOT,
): string | null => {
  const testPath = path.join(root, registration.concurrencyTest);
  if (!registration.concurrencyTest.endsWith(".postgres.test.ts")) {
    return `${registration.concurrencyTest} is not a *.postgres.test.ts suite`;
  }
  if (!existsSync(testPath)) {
    return `${registration.concurrencyTest} does not exist`;
  }
  if (!readFileSync(testPath, "utf-8").includes(OVERLAP_HELPER)) {
    return `${registration.concurrencyTest} never opens two clients through ${OVERLAP_HELPER}`;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          unregistered:
            "{{name}} decides completion from a count and writes a terminal status. Writers that overlap each count without the other's uncommitted rows, and PGlite cannot overlap two transactions. Serialize the writers through a row lock in apps/api/src/lib/db/aggregate-lock.ts, cover it with a *.postgres.test.ts that overlaps two transactions via withGatedTestClients, and register both in .oxlint-plugins/count-gated-completion.ts.",
          weakTest:
            "{{name}} is registered as count-gated, but {{problem}}. Its overlap suite must run on real PostgreSQL with two clients.",
          stale:
            "{{name}} is registered in .oxlint-plugins/count-gated-completion.ts but no longer reads a count and writes a terminal status here; remove the registration.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          Program(node) {
            const file = repoRelativeFilename(context);
            if (!inScope(file)) {
              return;
            }
            const text = context.sourceCode.text;
            const lineOf = (offset: number) =>
              text.slice(0, offset).split("\n").length;
            const found = countGatedFunctions(node, lineOf);
            const registered = COUNT_GATED_COMPLETIONS.filter(
              (registration) => registration.file === file,
            );
            for (const unit of found) {
              const registration = registered.find(
                (candidate) => candidate.fn === unit.name,
              );
              const loc = { line: unit.line, column: 0 };
              if (registration === undefined) {
                context.report({
                  loc,
                  messageId: "unregistered",
                  data: { name: unit.name },
                });
                continue;
              }
              const problem = overlapProblem(registration);
              if (problem !== null) {
                context.report({
                  loc,
                  messageId: "weakTest",
                  data: { name: unit.name, problem },
                });
              }
            }
            for (const registration of registered) {
              if (!found.some((unit) => unit.name === registration.fn)) {
                context.report({
                  node,
                  messageId: "stale",
                  data: { name: registration.fn },
                });
              }
            }
          },
        };
      },
    },
  },
});
