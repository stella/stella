import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { type Node, parseSource, walk } from "./syntax-tree";

const root = path.resolve(import.meta.dir, "../../..");
const factories = new Set([
  "apps/api/src/lib/redis-client.ts",
  "apps/collab/src/redis-client.ts",
]);
const factoryNames = new Set([
  "createRedisClient",
  "createBullMqConnection",
  "createCollabRedisClient",
]);

// A non-computed key's decoded name: `connection` and "connection" are
// both `connection`.
const staticKeyName = (key: Node): string | null => {
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : null;
};

const inspectConstruction = (source: string, file: string) => {
  // Escaped source is always parsed, so a module or binding written with
  // Unicode escapes cannot bypass the fast path.
  if (
    !/\b(?:RedisClient|createBunRedisClient|createRedisClient|createBullMqConnection|createCollabRedisClient|Bun|ioredis|bullmq)\b|["'](?:bun|redis)["']|\\/u.test(
      source,
    )
  ) {
    return { violations: [], declarations: [], uses: 0 };
  }
  const tree = parseSource(file, source);
  const violations: string[] = [];
  let uses = 0;
  const declarations: {
    storeClass: "durable-coordination" | "cache";
    factory: string;
  }[] = [];
  const queueConstructors = new Set([
    "Queue",
    "Worker",
    "QueueEvents",
    "FlowProducer",
    "JobScheduler",
  ]);
  const queueAliases = new Map<string, string>();
  const variables = new Map<string, Node>();
  const resolveVariable = (expression: Node) => {
    const seen = new Set<string>();
    let resolved = expression;
    while (resolved.type === "Identifier" && !seen.has(resolved.name)) {
      seen.add(resolved.name);
      const initializer = variables.get(resolved.name);
      if (initializer === undefined) {
        return resolved;
      }
      resolved = initializer;
    }
    return resolved;
  };
  const names = new Map([...factoryNames].map((name) => [name, name]));
  const factoryName = (expression: Node) => {
    if (expression.type === "Identifier") {
      return names.get(expression.name);
    }
    if (expression.type !== "MemberExpression") {
      return undefined;
    }
    let name: string | undefined;
    if (!expression.computed && expression.property.type === "Identifier") {
      name = expression.property.name;
    } else if (
      expression.computed &&
      expression.property.type === "Literal" &&
      typeof expression.property.value === "string"
    ) {
      name = expression.property.value;
    }
    return name !== undefined && factoryNames.has(name) ? name : undefined;
  };
  const registerBindings = (binding: Node) => {
    if (binding.type !== "ObjectPattern") {
      return;
    }
    for (const element of binding.properties) {
      if (element.type !== "Property") {
        continue;
      }
      const local =
        element.value.type === "AssignmentPattern"
          ? element.value.left
          : element.value;
      if (
        !element.computed &&
        element.key.type === "Identifier" &&
        factoryNames.has(element.key.name) &&
        local.type === "Identifier"
      ) {
        names.set(local.name, element.key.name);
      }
    }
  };
  const owner = factories.has(file);
  const forbiddenBinding = (name: string, module: string) =>
    module === "ioredis" ||
    module === "redis" ||
    (module === "bun" && ["RedisClient", "redis", "*"].includes(name)) ||
    (module === "bullmq" && ["createBunRedisClient", "*"].includes(name));
  const inspectImports = (node: Node) => {
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      const module = node.source.value;
      for (const binding of node.specifiers) {
        if (binding.type !== "ImportSpecifier") {
          if (forbiddenBinding("*", module) && !owner) {
            violations.push("raw-client-import");
          }
          continue;
        }
        if (binding.importKind === "type") {
          continue;
        }
        const imported =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        if (module === "bullmq" && queueConstructors.has(imported)) {
          queueAliases.set(binding.local.name, imported);
        }
        if (factoryNames.has(imported)) {
          names.set(binding.local.name, imported);
        }
        if (forbiddenBinding(imported, module) && !owner) {
          violations.push("raw-client-import");
        }
      }
    }
    if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source &&
      node.exportKind !== "type" &&
      !owner
    ) {
      const module = node.source.value;
      if (
        ["bun", "bullmq", "ioredis", "redis"].includes(module) &&
        (node.type === "ExportAllDeclaration" ||
          node.specifiers.some(
            (binding) =>
              binding.exportKind !== "type" &&
              forbiddenBinding(
                binding.local.type === "Identifier"
                  ? binding.local.name
                  : binding.local.value,
                module,
              ),
          ))
      ) {
        violations.push("raw-client-export");
      }
    }
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      node.object.name === "Bun" &&
      node.property.type === "Identifier" &&
      ["RedisClient", "redis"].includes(node.property.name) &&
      !owner
    ) {
      violations.push("raw-client-global");
    }
  };
  const inspectCall = (node: Node, ancestors: readonly Node[]) => {
    if (node.type !== "CallExpression" && node.type !== "ImportExpression") {
      return;
    }
    const expression = node.type === "CallExpression" ? node.callee : undefined;
    let name: string | undefined;
    if (expression?.type === "Identifier") {
      name = expression.name;
    } else if (
      expression?.type === "MemberExpression" &&
      !expression.computed &&
      expression.property.type === "Identifier"
    ) {
      name = expression.property.name;
    }
    if ((node.type === "ImportExpression" || name === "require") && !owner) {
      const specifier =
        node.type === "ImportExpression" ? node.source : node.arguments.at(0);
      if (
        specifier?.type === "Literal" &&
        typeof specifier.value === "string"
      ) {
        const module = specifier.value;
        if (["bun", "bullmq", "ioredis", "redis"].includes(module)) {
          const parent = ancestors.at(-1);
          const declaration =
            node.type === "ImportExpression" &&
            parent?.type === "AwaitExpression"
              ? ancestors.at(-2)
              : parent;
          const binding =
            declaration?.type === "VariableDeclarator"
              ? declaration.id
              : undefined;
          const safeBun =
            module === "bun" &&
            binding?.type === "ObjectPattern" &&
            binding.properties.every(
              (element) =>
                element.type === "Property" &&
                !element.computed &&
                element.key.type === "Identifier" &&
                // The decoded name: an escaped `RedisClient` is the same binding.
                !forbiddenBinding(element.key.name, module),
            );
          if (!safeBun) {
            violations.push("raw-client-dynamic-import");
          }
        }
      }
    }
    if (node.type !== "CallExpression") {
      return;
    }
    const canonical = factoryName(node.callee);
    if (canonical === undefined) {
      return;
    }
    if (!owner) {
      uses += 1;
    }
    const options = node.arguments.at(0);
    const field =
      options?.type === "ObjectExpression"
        ? options.properties.find(
            (property) =>
              property.type === "Property" &&
              !property.computed &&
              property.kind === "init" &&
              !property.method &&
              !property.shorthand &&
              staticKeyName(property.key) === "storeClass",
          )
        : undefined;
    if (
      field?.type === "Property" &&
      field.value.type === "Literal" &&
      (field.value.value === "durable-coordination" ||
        field.value.value === "cache")
    ) {
      if (!owner) {
        declarations.push({
          storeClass: field.value.value,
          factory: canonical,
        });
      }
      if (
        canonical === "createBullMqConnection" &&
        field.value.value !== "durable-coordination"
      ) {
        violations.push("queue-store-class");
      }
    } else if (!owner) {
      violations.push("undeclared-store-class");
    }
  };
  const inspectQueueConstruction = (node: Node) => {
    if (
      node.type !== "NewExpression" ||
      owner ||
      node.callee.type !== "Identifier"
    ) {
      return;
    }
    const constructor = queueAliases.get(node.callee.name);
    if (constructor === undefined) {
      return;
    }
    const argument = node.arguments.at(constructor === "Worker" ? 2 : 1);
    const options =
      argument === undefined ? undefined : resolveVariable(argument);
    const connection =
      options?.type === "ObjectExpression"
        ? options.properties.find(
            (property) =>
              property.type === "Property" &&
              !property.computed &&
              property.kind === "init" &&
              !property.method &&
              staticKeyName(property.key) === "connection",
          )
        : undefined;
    if (
      connection?.type !== "Property" ||
      resolveVariable(connection.value).type === "ObjectExpression"
    ) {
      violations.push("unclassified-queue-connection");
    }
  };
  walk(tree.program, (node, ancestors) => {
    if (node.type === "VariableDeclarator") {
      registerBindings(node.id);
      if (node.init && node.id.type === "Identifier") {
        variables.set(node.id.name, node.init);
        const canonical = factoryName(node.init);
        if (canonical !== undefined) {
          names.set(node.id.name, canonical);
        }
      }
    }
    if (
      node.type === "AssignmentPattern" &&
      node.left.type === "Identifier" &&
      (ancestors.at(-1)?.type === "Property" ||
        ancestors.at(-1)?.type === "ArrayPattern")
    ) {
      const canonical = factoryName(node.right);
      if (canonical !== undefined) {
        names.set(node.left.name, canonical);
      }
    }
    inspectImports(node);
    inspectCall(node, ancestors);
    inspectQueueConstruction(node);
  });
  return { violations, declarations, uses };
};

test("application clients declare their class through configured factories", () => {
  const violations: string[] = [];
  const inventory: ReturnType<typeof inspectConstruction>["declarations"] = [];
  for (const file of new Bun.Glob(
    "{apps,packages}/*/{src,scripts}/**/*.{ts,tsx}",
  ).scanSync({ cwd: root, onlyFiles: true })) {
    if (
      file.includes("/__fixtures__/") ||
      /\.(?:test|spec)\.[cm]?tsx?$/u.test(file) ||
      file.includes("/tests/")
    ) {
      continue;
    }
    const result = inspectConstruction(
      readFileSync(path.join(root, file), "utf-8"),
      file,
    );
    expect(result.declarations.length, file).toBe(result.uses);
    violations.push(
      ...result.violations.map((violation) => `${file}: ${violation}`),
    );
    inventory.push(...result.declarations);
  }
  expect(violations).toEqual([]);
  expect(inventory.length).toBeGreaterThan(0);
  expect(new Set(inventory.map(({ storeClass }) => storeClass))).toEqual(
    new Set(["cache", "durable-coordination"]),
  );
}, 30_000);

for (const source of [
  'import { RedisClient as Client } from "bun"; new Client();',
  'import * as driver from "bun"; new driver.RedisClient();',
  'const driver = await import("bun"); new driver.RedisClient();',
  'const { RedisClient: Client } = await import("bun"); new Client();',
  'const driver = require("ioredis"); new driver();',
  'const driver = await import("bullmq"); driver.createBunRedisClient();',
  'export { RedisClient } from "bun";',
  'import Driver from "\\x69oredis"; new Driver();',

  "new Bun.RedisClient();",
  'import { createRedisClient as create } from "@/api/lib/redis-client"; create();',
  'const factory = await import("@/api/lib/redis-client"); factory.createRedisClient({});',
  'createBullMqConnection({ storeClass: "cache" });',
  'import { Queue } from "bullmq"; new Queue("example", { connection: { host: "localhost" } });',
  'import { Queue } from "bullmq"; const connection = { host: "localhost" }; const options = { connection }; new Queue("example", options);',

  'import { Worker as Processor } from "bullmq"; new Processor("example", async () => {}, { connection: {} });',

  'createRedisClient({ storeClass: "other" });',
  'const { createRedisClient: make } = await import("@/api/lib/redis-client"); make();',
  "const make = createRedisClient; make();",
  'factory["createRedisClient"]();',
  'import { createBullMqConnection as make } from "@/api/lib/redis-client"; make({ storeClass: "cache" });',
  'const { \\u0052edisClient } = await import("bun");',
]) {
  test(`the construction guard rejects an invalid declaration: ${source}`, () => {
    expect(
      inspectConstruction(source, "apps/api/src/lib/example.ts").violations
        .length,
    ).toBeGreaterThan(0);
  });
}

test("type imports and declared factory aliases remain available", () => {
  const result = inspectConstruction(
    [
      'import type { RedisClient } from "bun";',
      'import { createRedisClient as create } from "@/api/lib/redis-client";',
      'create({ storeClass: "durable-coordination" });',
      'const { Glob } = await import("bun");',
    ].join("\n"),
    "apps/api/src/lib/example.ts",
  );
  expect(result.violations).toEqual([]);
  expect(result.declarations).toEqual([
    { storeClass: "durable-coordination", factory: "createRedisClient" },
  ]);
});

test("a quoted or escaped storeClass key declares the store class", () => {
  const result = inspectConstruction(
    [
      'import { createRedisClient as create } from "@/api/lib/redis-client";',
      'create({ "storeClass": "durable-coordination" });',
      'create({ \\u0073toreClass: "durable-coordination" });',
    ].join("\n"),
    "apps/api/src/lib/example.ts",
  );
  expect(result.violations).toEqual([]);
  expect(result.declarations).toEqual([
    { storeClass: "durable-coordination", factory: "createRedisClient" },
    { storeClass: "durable-coordination", factory: "createRedisClient" },
  ]);
});

test("the deliberately invalid construction fixture is rejected", () => {
  const file = path.join(
    import.meta.dir,
    "__fixtures__/undeclared-store.fixture",
  );
  expect(
    inspectConstruction(
      readFileSync(file, "utf-8"),
      "apps/api/src/lib/example.ts",
    ).violations,
  ).toEqual([
    "raw-client-import",
    "raw-client-dynamic-import",
    "undeclared-store-class",
  ]);
});
