import path from "node:path";
import ts from "typescript6";

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
  parsed: ts.SourceFile,
) =>
  DATABASE_SUITE_NAME.test(relativePath) ||
  DATABASE_SOURCE_MARKERS.some((marker) => source.includes(marker)) ||
  parsed.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false;
    }
    const specifier = statement.moduleSpecifier.text;
    return DATABASE_PROVIDER_IMPORTS.some((pattern) => pattern.test(specifier));
  });

const collectBindings = (parsed: ts.SourceFile): PropertyBindings => {
  const bindings: PropertyBindings = {
    assertProperty: new Set(),
    propertyConfig: new Set(),
    fastCheck: new Set(),
  };
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (statement.moduleSpecifier.text === "fast-check") {
      if (clause?.name) {
        bindings.fastCheck.add(clause.name.text);
      }
      if (named && ts.isNamespaceImport(named)) {
        bindings.fastCheck.add(named.name.text);
      }
    }
    if (
      statement.moduleSpecifier.text !== "@stll/property-testing" ||
      !named ||
      !ts.isNamedImports(named)
    ) {
      continue;
    }
    for (const binding of named.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (imported === "assertProperty") {
        bindings.assertProperty.add(binding.name.text);
      } else if (imported === "propertyConfig") {
        bindings.propertyConfig.add(binding.name.text);
      }
    }
  }
  return bindings;
};

const hasNumRuns = (expression: ts.Expression | undefined) =>
  expression !== undefined &&
  ts.isObjectLiteralExpression(expression) &&
  expression.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "numRuns",
  );

const isBudgetedConfigCall = (
  node: ts.Node,
  propertyConfig: Set<string>,
): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  propertyConfig.has(node.expression.text) &&
  hasNumRuns(node.arguments.at(0));

// Top-level config helpers such as `config(40)` that build a budgeted
// `propertyConfig({ numRuns })` count as an explicit budget.
const collectBudgetedHelpers = (
  parsed: ts.SourceFile,
  propertyConfig: Set<string>,
) => {
  const buildsBudget = (node: ts.Node): boolean =>
    isBudgetedConfigCall(node, propertyConfig) ||
    node.getChildren(parsed).some(buildsBudget);
  const helpers = new Set<string>();
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && statement.body && buildsBudget(statement.body)) {
        helpers.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const { name, initializer } of statement.declarationList
      .declarations) {
      if (
        ts.isIdentifier(name) &&
        initializer !== undefined &&
        (ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer)) &&
        buildsBudget(initializer.body)
      ) {
        helpers.add(name.text);
      }
    }
  }
  return helpers;
};

export const inspectDatabasePropertyBudgets = (
  input: SourceInput,
): string[] => {
  const parsed = ts.createSourceFile(
    input.relativePath,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (!isDatabaseBacked(input, parsed)) {
    return [];
  }
  const bindings = collectBindings(parsed);
  const budgetedHelpers = collectBudgetedHelpers(
    parsed,
    bindings.propertyConfig,
  );

  // Only a literal budget counts: `{ numRuns }`, `propertyConfig({ numRuns })`
  // or a budgeted helper call.
  const hasExplicitBudget = (expression: ts.Expression | undefined) =>
    expression !== undefined &&
    (hasNumRuns(expression) ||
      isBudgetedConfigCall(expression, bindings.propertyConfig) ||
      (ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        budgetedHelpers.has(expression.expression.text)));

  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const sharedAssertion =
        ts.isIdentifier(callee) && bindings.assertProperty.has(callee.text);
      const fastCheckAssertion =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bindings.fastCheck.has(callee.expression.text) &&
        callee.name.text === "assert";
      if (
        (sharedAssertion || fastCheckAssertion) &&
        !hasExplicitBudget(node.arguments.at(sharedAssertion ? 2 : 1))
      ) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart());
        violations.push(
          `${input.relativePath}:${line + 1}: property in a database-backed test file must configure an explicit numRuns`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
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
