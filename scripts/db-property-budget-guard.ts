import path from "node:path";

import {
  type Node,
  parseSource,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";

const API_TEST_GLOB = "apps/api/src/**/*.test.ts";

// A file is database-backed when it imports a test database provider, is
// named as a database suite, or reads a database URL. Every property in such
// a file needs a budget: tracing which properties reach the database misses
// imported helpers, so the file is the unit.
const DATABASE_PROVIDER_IMPORTS = [
  /^@\/api\/tests\/security\//u,
  /^@\/api\/tests\/pglite-test-db$/u,
  /^@\/api\/tests\/gated-test-database$/u,
];
const DATABASE_SUITE_NAME = /\.(?:postgres|db)\.test\.ts$/u;
const DATABASE_SOURCE_MARKERS = [
  "DATABASE_URL",
  "databaseUrl",
  "getTestDb(",
  "createTestDatabase(",
] as const;

type SourceInput = { relativePath: string; source: string };

type PropertyBindings = {
  assertProperty: Set<string>;
  propertyConfig: Set<string>;
  fastCheck: Set<string>;
};

const isDatabaseBacked = (
  { relativePath, source }: SourceInput,
  program: Program,
) =>
  DATABASE_SUITE_NAME.test(relativePath) ||
  DATABASE_SOURCE_MARKERS.some((marker) => source.includes(marker)) ||
  program.body.some((statement) => {
    if (statement.type !== "ImportDeclaration") {
      return false;
    }
    const specifier = statement.source.value;
    return DATABASE_PROVIDER_IMPORTS.some((pattern) => pattern.test(specifier));
  });

const collectBindings = (program: Program): PropertyBindings => {
  const bindings: PropertyBindings = {
    assertProperty: new Set(),
    propertyConfig: new Set(),
    fastCheck: new Set(),
  };
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const specifier = statement.source.value;
    for (const binding of statement.specifiers) {
      if (binding.type !== "ImportSpecifier") {
        if (specifier === "fast-check") {
          bindings.fastCheck.add(binding.local.name);
        }
        continue;
      }
      if (specifier !== "@stll/property-testing") {
        continue;
      }
      const imported =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
      if (imported === "assertProperty") {
        bindings.assertProperty.add(binding.local.name);
      } else if (imported === "propertyConfig") {
        bindings.propertyConfig.add(binding.local.name);
      }
    }
  }
  return bindings;
};

const hasNumRuns = (expression: Node | undefined) =>
  expression?.type === "ObjectExpression" &&
  expression.properties.some(
    (property) =>
      property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.computed &&
      ((property.key.type === "Identifier" &&
        property.key.name === "numRuns") ||
        (property.key.type === "Literal" && property.key.value === "numRuns")),
  );

const isBudgetedConfigCall = (node: Node, propertyConfig: Set<string>) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  propertyConfig.has(node.callee.name) &&
  hasNumRuns(node.arguments.at(0));

// Top-level config helpers such as `config(40)` that build a budgeted
// `propertyConfig({ numRuns })` count as an explicit budget.
const collectBudgetedHelpers = (
  program: Program,
  propertyConfig: Set<string>,
) => {
  const buildsBudget = (root: Node): boolean => {
    let found = false;
    walk(root, (node) => {
      if (found || isBudgetedConfigCall(node, propertyConfig)) {
        found = true;
        return "skip-children";
      }
      return undefined;
    });
    return found;
  };
  const helpers = new Set<string>();
  for (const topLevel of program.body) {
    // `export` wraps the declaration it exports.
    const statement =
      topLevel.type === "ExportNamedDeclaration" ||
      topLevel.type === "ExportDefaultDeclaration"
        ? topLevel.declaration
        : topLevel;
    if (statement?.type === "FunctionDeclaration") {
      if (statement.id && statement.body && buildsBudget(statement.body)) {
        helpers.add(statement.id.name);
      }
      continue;
    }
    if (statement?.type !== "VariableDeclaration") {
      continue;
    }
    for (const { id, init } of statement.declarations) {
      if (
        id.type === "Identifier" &&
        (init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression") &&
        init.body !== null &&
        buildsBudget(init.body)
      ) {
        helpers.add(id.name);
      }
    }
  }
  return helpers;
};

export const inspectDatabasePropertyBudgets = (
  input: SourceInput,
): string[] => {
  const parsed = parseSource(input.relativePath, input.source);
  const { program } = parsed;
  if (!isDatabaseBacked(input, program)) {
    return [];
  }
  const bindings = collectBindings(program);
  const budgetedHelpers = collectBudgetedHelpers(
    program,
    bindings.propertyConfig,
  );

  // Only a literal budget counts: `{ numRuns }`, `propertyConfig({ numRuns })`
  // or a budgeted helper call.
  const hasExplicitBudget = (expression: Node | undefined) =>
    expression !== undefined &&
    (hasNumRuns(expression) ||
      isBudgetedConfigCall(expression, bindings.propertyConfig) ||
      (expression.type === "CallExpression" &&
        expression.callee.type === "Identifier" &&
        budgetedHelpers.has(expression.callee.name)));

  const violations: string[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const { callee } = node;
    const sharedAssertion =
      callee.type === "Identifier" && bindings.assertProperty.has(callee.name);
    const fastCheckAssertion =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      bindings.fastCheck.has(callee.object.name) &&
      callee.property.type === "Identifier" &&
      callee.property.name === "assert";
    if (
      (sharedAssertion || fastCheckAssertion) &&
      !hasExplicitBudget(node.arguments.at(sharedAssertion ? 2 : 1))
    ) {
      const { line } = parsed.locate(node.start);
      violations.push(
        `${input.relativePath}:${line}: property in a database-backed test file must configure an explicit numRuns`,
      );
    }
  });
  return violations;
};

const run = async () => {
  const root = path.resolve(import.meta.dir, "..");
  const violations: string[] = [];
  for await (const relativePath of new Bun.Glob(API_TEST_GLOB).scan({
    cwd: root,
  })) {
    violations.push(
      ...inspectDatabasePropertyBudgets({
        relativePath,
        source: await Bun.file(path.join(root, relativePath)).text(),
      }),
    );
  }
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await run();
}
