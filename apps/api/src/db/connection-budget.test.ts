import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

import { DEDICATED_CONNECTIONS_PER_PROCESS } from "@/api/db/dedicated-connection-slots";
import { envBaseServerSchema } from "@/api/env-base-schema";

import { DATABASE_CONNECTION_CONFIG } from "./connection-budget";

const {
  defaults: DATABASE_POOL_DEFAULTS,
  processes: DATABASE_PROCESS_ASSUMPTIONS,
  pools: DATABASE_POOLS,
  budget: DATABASE_CONNECTION_BUDGET,
  forProcess: connectionBudgetForProcess,
} = DATABASE_CONNECTION_CONFIG;

const apiRoot = path.resolve(import.meta.dir, "../..");

// Every Bun SQL client is built by this owner, so its factory is counted at
// each call site and the owner's own `new SQL` is not a pool of its own.
const SQL_CLIENT_OWNER = "src/db/sql-client";
const SQL_CLIENT_FACTORY = "createSqlClient";

// The apps/api-relative module a specifier names from `file`, without extension.
const apiModule = (file: string, specifier: string): string => {
  let resolved = specifier;
  if (specifier.startsWith("@/api/")) {
    resolved = `src/${specifier.slice("@/api/".length)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    resolved = path.posix.join(path.posix.dirname(file), specifier);
  }
  return resolved.replace(/\.[cm]?[jt]sx?$/u, "");
};

const collectConstructors = (file: string, contents: string) => {
  const source = parseSource(file, contents);
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
  const ownsClients = (specifier: string): boolean => {
    if (apiModule(file, specifier) !== SQL_CLIENT_OWNER) {
      return false;
    }
    importedConstructors.set(specifier, new Set([SQL_CLIENT_FACTORY]));
    return true;
  };
  const clientModule = (expression: Node): string | undefined => {
    if (expression.type === "AwaitExpression") {
      return clientModule(expression.argument);
    }
    if (expression.type === "ParenthesizedExpression") {
      return clientModule(expression.expression);
    }
    let name: Node | undefined;
    if (expression.type === "ImportExpression") {
      name = expression.source;
    } else if (
      expression.type === "CallExpression" &&
      expression.callee.type === "Identifier" &&
      expression.callee.name === "require"
    ) {
      name = expression.arguments.at(0);
    }
    return name?.type === "Literal" &&
      typeof name.value === "string" &&
      (importedConstructors.has(name.value) ||
        ownsClients(name.value) ||
        name.value.startsWith("drizzle-orm/"))
      ? name.value
      : undefined;
  };
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type" ||
      statement.specifiers.length === 0
    ) {
      continue;
    }
    const module = statement.source.value;
    ownsClients(module);
    const names = importedConstructors.get(module);
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportDefaultSpecifier" && names?.has("default")) {
        constructors.add(binding.local.name);
      }
      if (
        binding.type === "ImportNamespaceSpecifier" &&
        (names || module.startsWith("drizzle-orm/"))
      ) {
        namespaces.set(binding.local.name, module);
      }
      if (binding.type === "ImportSpecifier" && binding.importKind !== "type") {
        const name =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        if (names?.has(name)) {
          constructors.add(binding.local.name);
        }
        if (module.startsWith("drizzle-orm/") && name === "drizzle") {
          drivers.add(binding.local.name);
        }
      }
    }
  }
  const record = (maximum: string) =>
    found.push({ file, constructor: found.length + 1, maximum });
  const maximumOf = (options: Node | undefined): string => {
    if (options?.type !== "ObjectExpression") {
      return "unknown";
    }
    const maximum = options.properties.findLast(
      (property) =>
        property.type === "Property" &&
        property.kind === "init" &&
        !property.method &&
        !property.shorthand &&
        contents.slice(property.key.start, property.key.end) === "max",
    );
    if (maximum?.type !== "Property") {
      return "unknown";
    }
    const value = maximum.value;
    if (value.type === "Literal" && typeof value.value === "number") {
      return `fixed:${value.value}`;
    }
    if (value.type === "Identifier") {
      const constantMaximum = constants.get(value.name);
      if (constantMaximum !== undefined) {
        return `fixed:${constantMaximum}`;
      }
    }
    if (
      value.type === "MemberExpression" &&
      !value.computed &&
      value.property.type === "Identifier" &&
      contents.slice(value.object.start, value.object.end) === "envBase"
    ) {
      return `configured:${value.property.name}`;
    }
    return "unknown";
  };
  const isConstructor = (callee: Node) => {
    if (callee.type === "Identifier") {
      return constructors.has(callee.name);
    }
    if (callee.type !== "MemberExpression") {
      return false;
    }
    const expression = contents.slice(callee.object.start, callee.object.end);
    let member = "unknown";
    if (!callee.computed && callee.property.type === "Identifier") {
      member = callee.property.name;
    } else if (
      callee.computed &&
      callee.property.type === "Literal" &&
      typeof callee.property.value === "string"
    ) {
      member = callee.property.value;
    }
    if (
      (expression === "Bun" || expression === "globalThis.Bun") &&
      member === "SQL"
    ) {
      return true;
    }
    const module = namespaces.get(expression) ?? clientModule(callee.object);
    return (
      module !== undefined &&
      importedConstructors.get(module)?.has(member) === true
    );
  };
  const isDriver = (callee: Node) => {
    if (callee.type === "Identifier") {
      return drivers.has(callee.name);
    }
    if (
      callee.type !== "MemberExpression" ||
      callee.computed ||
      callee.property.type !== "Identifier"
    ) {
      return false;
    }
    const module =
      namespaces.get(contents.slice(callee.object.start, callee.object.end)) ??
      clientModule(callee.object);
    return (
      module?.startsWith("drizzle-orm/") === true &&
      callee.property.name === "drizzle"
    );
  };
  walk(source.program, (node) => {
    if (node.type !== "VariableDeclarator" || !node.init) {
      return;
    }
    const module = clientModule(node.init);
    if (module === undefined) {
      return;
    }
    if (node.id.type === "Identifier") {
      namespaces.set(node.id.name, module);
      if (importedConstructors.get(module)?.has("default")) {
        constructors.add(node.id.name);
      }
    }
    if (node.id.type === "ObjectPattern") {
      for (const element of node.id.properties) {
        if (element.type !== "Property") {
          continue;
        }
        const target =
          element.value.type === "AssignmentPattern"
            ? element.value.left
            : element.value;
        const name = contents.slice(element.key.start, element.key.end);
        if (target.type !== "Identifier") {
          continue;
        }
        if (module.startsWith("drizzle-orm/") && name === "drizzle") {
          drivers.add(target.name);
        }
        if (importedConstructors.get(module)?.has(name)) {
          constructors.add(target.name);
        }
      }
    }
  });
  walk(source.program, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      !node.init
    ) {
      return;
    }
    if (isConstructor(node.init)) {
      constructors.add(node.id.name);
    }
    if (isDriver(node.init)) {
      drivers.add(node.id.name);
    }
  });
  walk(source.program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "Literal" &&
      typeof node.init.value === "number"
    ) {
      constants.set(node.id.name, node.init.value);
    }
    if (node.type === "NewExpression" && isConstructor(node.callee)) {
      record(maximumOf(node.arguments.at(0)));
    }
    if (node.type === "CallExpression") {
      if (isConstructor(node.callee)) {
        record(maximumOf(node.arguments.at(0)));
      }
      if (isDriver(node.callee)) {
        const options = node.arguments.at(0);
        if (
          options?.type !== "ObjectExpression" ||
          !options.properties.some(
            (property) =>
              property.type === "Property" &&
              property.kind === "init" &&
              !property.method &&
              contents.slice(property.key.start, property.key.end) === "client",
          )
        ) {
          record("implicit-driver-client");
        }
      }
    }
  });
  return found;
};

describe("database connection budget", () => {
  test("every production client constructor and maximum has a budget entry", () => {
    const actual = [
      ...new Bun.Glob("{src,scripts}/**/*.{ts,tsx}").scanSync({ cwd: apiRoot }),
    ]
      .filter(
        (file) =>
          !/(?:\.test\.|(?:^|\/)(?:tests|__tests__)\/)/u.test(file) &&
          apiModule("", file) !== SQL_CLIENT_OWNER,
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
        "src/lib/owned.ts",
        [
          'import { createSqlClient as make } from "@/api/db/sql-client";',
          'import * as owner from "../db/sql-client.ts";',
          "make({max: 7});",
          "owner.createSqlClient({max: 8});",
          'const { createSqlClient: hidden } = await import("../db/sql-client");',
          "hidden({max: 9});",
        ].join("\n"),
      ).map(({ maximum }) => maximum),
    ).toEqual(["fixed:7", "fixed:8", "fixed:9"]);
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
    const processNames = new Set<keyof typeof DATABASE_PROCESS_ASSUMPTIONS>();
    for (const { processes } of DATABASE_POOLS) {
      for (const process of processes) {
        processNames.add(process);
      }
    }
    expect(Array.from(processNames, String).toSorted()).toEqual(
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
        DEDICATED_CONNECTIONS_PER_PROCESS,
    );
  });
});
