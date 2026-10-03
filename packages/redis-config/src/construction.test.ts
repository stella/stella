import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
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
  const variables = new Map<string, ts.Expression>();
  const resolveVariable = (expression: ts.Expression) => {
    const seen = new Set<string>();
    let resolved = expression;
    while (ts.isIdentifier(resolved) && !seen.has(resolved.text)) {
      seen.add(resolved.text);
      const initializer = variables.get(resolved.text);
      if (initializer === undefined) {return resolved;}
      resolved = initializer;
    }
    return resolved;
  };
  const names = new Map([...factoryNames].map((name) => [name, name]));
  const factoryName = (expression: ts.Expression) => {
    if (ts.isIdentifier(expression)) {
      return names.get(expression.text);
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      factoryNames.has(expression.name.text)
    ) {
      return expression.name.text;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression) &&
      factoryNames.has(expression.argumentExpression.text)
    ) {
      return expression.argumentExpression.text;
    }
    return undefined;
  };
  const registerBindings = (binding: ts.BindingName) => {
    if (!ts.isObjectBindingPattern(binding)) {
      return;
    }
    for (const element of binding.elements) {
      const imported = element.propertyName ?? element.name;
      if (
        ts.isIdentifier(imported) &&
        factoryNames.has(imported.text) &&
        ts.isIdentifier(element.name)
      ) {
        names.set(element.name.text, imported.text);
      }
    }
  };
  const owner = factories.has(file);
  const forbiddenBinding = (name: string, module: string) =>
    module === "ioredis" ||
    module === "redis" ||
    (module === "bun" &&
      (name === "RedisClient" || name === "redis" || name === "*")) ||
    (module === "bullmq" && (name === "createBunRedisClient" || name === "*"));
  const inspectImports = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause !== undefined && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (
          clause.name !== undefined &&
          forbiddenBinding("*", module) &&
          !owner
        ) {
          violations.push("raw-client-import");
        }
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          if (forbiddenBinding("*", module) && !owner) {
            violations.push("raw-client-import");
          }
        } else if (bindings !== undefined) {
          for (const binding of bindings.elements) {
            if (binding.isTypeOnly) {
              continue;
            }
            const imported = (binding.propertyName ?? binding.name).text;
            if (module === "bullmq" && queueConstructors.has(imported)) {
              queueAliases.set(binding.name.text, imported);
            }
            if (factoryNames.has(imported)) {
              names.set(binding.name.text, imported);
            }
            if (forbiddenBinding(imported, module) && !owner) {
              violations.push("raw-client-import");
            }
          }
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      if (
        !node.isTypeOnly &&
        !owner &&
        ["bun", "bullmq", "ioredis", "redis"].includes(module)
      ) {
        const clause = node.exportClause;
        if (
          clause === undefined ||
          !ts.isNamedExports(clause) ||
          clause.elements.some(
            (binding) =>
              !binding.isTypeOnly &&
              forbiddenBinding(
                (binding.propertyName ?? binding.name).text,
                module,
              ),
          )
        ) {
          violations.push("raw-client-export");
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Bun" &&
      ["RedisClient", "redis"].includes(node.name.text) &&
      !owner
    ) {
      violations.push("raw-client-global");
    }
  };
  const inspectCall = (node: ts.CallExpression) => {
    const expression = node.expression;
    let name: string | undefined;
    if (ts.isIdentifier(expression)) {
      name = expression.text;
    } else if (ts.isPropertyAccessExpression(expression)) {
      name = expression.name.text;
    }
    if (
      (expression.kind === ts.SyntaxKind.ImportKeyword || name === "require") &&
      !owner
    ) {
      const specifier = node.arguments.at(0);
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        const module = specifier.text;
        if (["bun", "bullmq", "ioredis", "redis"].includes(module)) {
          // Named destructuring of unrelated Bun utilities cannot expose a client.
          const declaration =
            expression.kind === ts.SyntaxKind.ImportKeyword &&
            ts.isAwaitExpression(node.parent)
              ? node.parent.parent
              : node.parent;
          const binding = ts.isVariableDeclaration(declaration)
            ? declaration.name
            : undefined;
          const safeBun =
            module === "bun" &&
            binding !== undefined &&
            ts.isObjectBindingPattern(binding) &&
            binding.elements.every(
              (element) =>
                element.dotDotDotToken === undefined &&
                ts.isIdentifier(element.propertyName ?? element.name) &&
                !forbiddenBinding(
                  (element.propertyName ?? element.name).getText(tree),
                  module,
                ),
            );
          if (!safeBun) {
            violations.push("raw-client-dynamic-import");
          }
        }
      }
    }
    const canonical = factoryName(expression);
    if (canonical !== undefined) {
      if (!owner) {
        uses += 1;
      }
      const options = node.arguments.at(0);
      const field =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(tree) === "storeClass",
            )
          : undefined;
      if (
        field !== undefined &&
        ts.isPropertyAssignment(field) &&
        ts.isStringLiteral(field.initializer) &&
        (field.initializer.text === "durable-coordination" ||
          field.initializer.text === "cache")
      ) {
        if (!owner) {
          declarations.push({
            storeClass: field.initializer.text,
            factory: canonical,
          });
        }
        if (
          canonical === "createBullMqConnection" &&
          field.initializer.text !== "durable-coordination"
        ) {
          violations.push("queue-store-class");
        }
      } else if (!owner) {
        violations.push("undeclared-store-class");
      }
    }
  };
  const inspectQueueConstruction = (node: ts.NewExpression) => {
    if (owner || !ts.isIdentifier(node.expression)) {
      return;
    }
    const constructor = queueAliases.get(node.expression.text);
    if (constructor === undefined) {
      return;
    }
    const argument = node.arguments?.at(constructor === "Worker" ? 2 : 1);
    const options =
      argument === undefined ? undefined : resolveVariable(argument);
    const connection =
      options !== undefined && ts.isObjectLiteralExpression(options)
        ? options.properties.find(
            (property) =>
              (ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)) &&
              property.name.getText(tree) === "connection",
          )
        : undefined;
    if (
      connection === undefined ||
      !(
        ts.isPropertyAssignment(connection) ||
        ts.isShorthandPropertyAssignment(connection)
      ) ||
      ts.isObjectLiteralExpression(
        resolveVariable(
          ts.isShorthandPropertyAssignment(connection)
            ? connection.name
            : connection.initializer,
        ),
      )
    ) {
      violations.push("unclassified-queue-connection");
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      registerBindings(node.name);
      if (node.initializer !== undefined && ts.isIdentifier(node.name)) {
        variables.set(node.name.text, node.initializer);
        const canonical = factoryName(node.initializer);
        if (canonical !== undefined) {
          names.set(node.name.text, canonical);
        }
      }
    }
    if (
      ts.isBindingElement(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      const canonical = factoryName(node.initializer);
      if (canonical !== undefined) {
        names.set(node.name.text, canonical);
      }
    }
    inspectImports(node);
    if (ts.isCallExpression(node)) {
      inspectCall(node);
    }
    if (ts.isNewExpression(node)) {
      inspectQueueConstruction(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
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
