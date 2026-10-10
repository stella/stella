import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { envBaseServerSchema } from "@/api/env-base-schema";
import { LIMITS } from "@/api/lib/limits";

import { DATABASE_CONNECTION_CONFIG } from "./connection-budget";

const {
  defaults: DATABASE_POOL_DEFAULTS,
  processes: DATABASE_PROCESS_ASSUMPTIONS,
  pools: DATABASE_POOLS,
  budget: DATABASE_CONNECTION_BUDGET,
  forProcess: connectionBudgetForProcess,
} = DATABASE_CONNECTION_CONFIG;

const apiRoot = path.resolve(import.meta.dir, "../..");

const collectConstructors = (file: string, contents: string) => {
  const source = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const constructors = new Set<string>();
  const namespaces = new Map<string, string>();
  const drivers = new Set<string>();
  const constants = new Map<string, number>();
  const found: { file: string; constructor: number; maximum: string }[] = [];
  const importedConstructors = new Map([
    ["bun", new Set(["SQL"])],
    ["pg", new Set(["Pool", "Client"])],
    ["postgres", new Set(["default"])],
  ]);
  const clientModule = (expression: ts.Expression): string | undefined => {
    if (
      ts.isAwaitExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    ) {
      return clientModule(expression.expression);
    }
    if (!ts.isCallExpression(expression)) {
      return undefined;
    }
    if (
      expression.expression.kind !== ts.SyntaxKind.ImportKeyword &&
      !(
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "require"
      )
    ) {
      return undefined;
    }
    const name = expression.arguments.at(0);
    return name &&
      ts.isStringLiteral(name) &&
      (importedConstructors.has(name.text) ||
        name.text.startsWith("drizzle-orm/"))
      ? name.text
      : undefined;
  };
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    const names = importedConstructors.get(module);
    if (clause.name && names?.has("default")) {
      constructors.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (
      bindings &&
      ts.isNamespaceImport(bindings) &&
      (names || module.startsWith("drizzle-orm/"))
    ) {
      namespaces.set(bindings.name.text, module);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) {
          continue;
        }
        const name = binding.propertyName?.text ?? binding.name.text;
        if (names?.has(name)) {
          constructors.add(binding.name.text);
        }
        if (module.startsWith("drizzle-orm/") && name === "drizzle") {
          drivers.add(binding.name.text);
        }
      }
    }
  }
  const record = (maximum: string) =>
    found.push({ file, constructor: found.length + 1, maximum });
  const maximumOf = (options: ts.Expression | undefined): string => {
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      return "unknown";
    }
    const maximum = options.properties.findLast(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(source) === "max",
    );
    if (maximum === undefined || !ts.isPropertyAssignment(maximum)) {
      return "unknown";
    }
    const value = maximum.initializer;
    if (ts.isNumericLiteral(value)) {
      return `fixed:${value.text}`;
    }
    if (ts.isIdentifier(value) && constants.has(value.text)) {
      return `fixed:${constants.get(value.text)}`;
    }
    if (
      ts.isPropertyAccessExpression(value) &&
      value.expression.getText(source) === "envBase"
    ) {
      return `configured:${value.name.text}`;
    }
    return "unknown";
  };
  const isConstructor = (callee: ts.Expression) => {
    if (ts.isIdentifier(callee)) {
      return constructors.has(callee.text);
    }
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return false;
    }
    const expression = callee.expression.getText(source);
    let member = "unknown";
    if (ts.isPropertyAccessExpression(callee)) {
      member = callee.name.text;
    } else if (
      callee.argumentExpression &&
      ts.isStringLiteral(callee.argumentExpression)
    ) {
      member = callee.argumentExpression.text;
    }
    if (
      (expression === "Bun" || expression === "globalThis.Bun") &&
      member === "SQL"
    ) {
      return true;
    }
    const module =
      namespaces.get(expression) ?? clientModule(callee.expression);
    return (
      module !== undefined &&
      importedConstructors.get(module)?.has(member) === true
    );
  };
  const isDriver = (callee: ts.Expression) => {
    if (ts.isIdentifier(callee)) {
      return drivers.has(callee.text);
    }
    if (!ts.isPropertyAccessExpression(callee)) {
      return false;
    }
    const module =
      namespaces.get(callee.expression.getText(source)) ??
      clientModule(callee.expression);
    return (
      module?.startsWith("drizzle-orm/") === true &&
      callee.name.text === "drizzle"
    );
  };
  const bindDynamicImports = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const module = clientModule(node.initializer);
      if (module !== undefined) {
        if (ts.isIdentifier(node.name)) {
          namespaces.set(node.name.text, module);
          if (importedConstructors.get(module)?.has("default")) {
            constructors.add(node.name.text);
          }
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const name =
              element.propertyName?.getText(source) ??
              element.name.getText(source);
            if (
              ts.isIdentifier(element.name) &&
              module.startsWith("drizzle-orm/") &&
              name === "drizzle"
            ) {
              drivers.add(element.name.text);
            }
            if (
              ts.isIdentifier(element.name) &&
              importedConstructors
                .get(module)
                ?.has(
                  element.propertyName?.getText(source) ?? element.name.text,
                )
            ) {
              constructors.add(element.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, bindDynamicImports);
  };
  bindDynamicImports(source);
  const bindAliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isConstructor(node.initializer)
    ) {
      constructors.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isDriver(node.initializer)
    ) {
      drivers.add(node.name.text);
    }
    ts.forEachChild(node, bindAliases);
  };
  bindAliases(source);
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNumericLiteral(node.initializer)
    ) {
      constants.set(node.name.text, Number(node.initializer.text));
    }
    if (ts.isNewExpression(node) && isConstructor(node.expression)) {
      record(maximumOf(node.arguments?.at(0)));
    }
    if (ts.isCallExpression(node)) {
      if (isConstructor(node.expression)) {
        record(maximumOf(node.arguments.at(0)));
      }
      if (isDriver(node.expression)) {
        const options = node.arguments.at(0);
        if (
          !options ||
          !ts.isObjectLiteralExpression(options) ||
          !options.properties.some(
            (property) =>
              (ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)) &&
              property.name.getText(source) === "client",
          )
        ) {
          record("implicit-driver-client");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe("database connection budget", () => {
  test("every production client constructor and maximum has a budget entry", () => {
    const actual = [
      ...new Bun.Glob("{src,scripts}/**/*.{ts,tsx}").scanSync({ cwd: apiRoot }),
    ]
      .filter(
        (file) => !/(?:\.test\.|(?:^|\/)(?:tests|__tests__)\/)/u.test(file),
      )
      .toSorted()
      .flatMap((file) =>
        collectConstructors(
          file,
          readFileSync(path.join(apiRoot, file), "utf-8"),
        ),
      );
    const declared = DATABASE_POOLS.map(({ file, constructor, maximum }) => ({
      file,
      constructor,
      maximum:
        maximum.type === "fixed"
          ? `fixed:${maximum.value}`
          : `configured:${maximum.key}`,
    })).toSorted((left, right) => {
      if (left.file < right.file) {
        return -1;
      }
      if (left.file > right.file) {
        return 1;
      }
      return left.constructor - right.constructor;
    });
    expect(actual).toEqual(declared);
  });

  test("the census sees aliases, namespaces, global clients, and new constructors", () => {
    const actual = collectConstructors(
      "new-pool.ts",
      [
        'import { SQL as Client } from "bun";',
        'import * as bun from "bun";',
        "new Client({max: 1});",
        "new bun.SQL({max: 2});",
        "new Bun.SQL({max: 3});",
        'new bun["SQL"]({max: 4});',
      ].join("\n"),
    );
    expect(actual.map(({ maximum }) => maximum)).toEqual([
      "fixed:1",
      "fixed:2",
      "fixed:3",
      "fixed:4",
    ]);
    expect(actual).not.toEqual(DATABASE_POOLS);
    expect(
      collectConstructors(
        "hidden.ts",
        'const {SQL: Client} = await import("bun"); new Client({max: 1});',
      ),
    ).toEqual([{ file: "hidden.ts", constructor: 1, maximum: "fixed:1" }]);
    expect(
      collectConstructors(
        "unrelated.ts",
        'const {Transpiler} = await import("bun");',
      ),
    ).toEqual([]);
    expect(
      collectConstructors(
        "namespace.ts",
        'const bun = require("bun"); const Client = bun.SQL; new Client({max: 2});',
      ),
    ).toEqual([{ file: "namespace.ts", constructor: 1, maximum: "fixed:2" }]);
  });

  test("alternate drivers and implicit clients cannot avoid the census", () => {
    expect(
      collectConstructors(
        "drivers.ts",
        [
          'import {Pool as PgPool} from "pg";',
          'import postgres from "postgres";',
          'import {drizzle} from "drizzle-orm/bun-sql";',
          "new PgPool({max: 5});",
          "postgres({max: 6});",
          'drizzle({connection: "postgres://localhost/test"});',
          'import * as driver from "drizzle-orm/bun-sql";',
          'driver.drizzle("postgres://localhost/test");',
          'const {drizzle: hidden} = await import("drizzle-orm/bun-sql"); hidden("postgres://localhost/test");',
        ].join("\n"),
      ).map(({ maximum }) => maximum),
    ).toEqual([
      "fixed:5",
      "fixed:6",
      "implicit-driver-client",
      "implicit-driver-client",
      "implicit-driver-client",
    ]);
  });

  test("configured defaults come from the budget owner", () => {
    expect(v.parse(envBaseServerSchema.DATABASE_ROOT_POOL_MAX, undefined)).toBe(
      DATABASE_POOL_DEFAULTS.DATABASE_ROOT_POOL_MAX,
    );
    expect(v.parse(envBaseServerSchema.DATABASE_RLS_POOL_MAX, undefined)).toBe(
      DATABASE_POOL_DEFAULTS.DATABASE_RLS_POOL_MAX,
    );
    expect(
      v.parse(envBaseServerSchema.PUBLIC_LAW_DATABASE_POOL_MAX, undefined),
    ).toBe(DATABASE_POOL_DEFAULTS.PUBLIC_LAW_DATABASE_POOL_MAX);
  });

  test("configured fleet plus other clients keeps at least thirty percent spare", () => {
    const processNames = new Set(
      DATABASE_POOLS.flatMap(({ processes }) => [...processes]),
    );
    expect([...processNames].toSorted()).toEqual(
      Object.keys(DATABASE_PROCESS_ASSUMPTIONS).toSorted(),
    );
    const managed = [...processNames].reduce(
      (total, process) => total + connectionBudgetForProcess(process).fleet,
      0,
    );
    const available =
      DATABASE_CONNECTION_BUDGET.minimumMaxConnections -
      DATABASE_CONNECTION_BUDGET.reservedConnectionsCeiling;
    expect(
      managed + DATABASE_CONNECTION_BUDGET.otherClientsCeiling,
    ).toBeLessThanOrEqual(
      Math.floor(
        (available * DATABASE_CONNECTION_BUDGET.utilizationPercent) / 100,
      ),
    );
    const oversized = connectionBudgetForProcess("api", {
      ...DATABASE_PROCESS_ASSUMPTIONS.api,
      maxReplicas: 100,
    }).fleet;
    expect(oversized).toBeGreaterThan(available);
  });

  test("separate public reads and dedicated sessions are counted without sharing root capacity", () => {
    const shared = connectionBudgetForProcess("operator");
    const separate = connectionBudgetForProcess("operator", {
      ...DATABASE_PROCESS_ASSUMPTIONS.operator,
      publicPool: "separate",
    });
    expect(separate.perProcess - shared.perProcess).toBe(
      DATABASE_POOL_DEFAULTS.PUBLIC_LAW_DATABASE_POOL_MAX,
    );
    expect(shared.perProcess).toBe(
      DATABASE_POOL_DEFAULTS.DATABASE_ROOT_POOL_MAX +
        DATABASE_POOL_DEFAULTS.DATABASE_RLS_POOL_MAX +
        LIMITS.databaseDedicatedConnectionsPerProcess,
    );
  });
});
