import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { type Node, parseSource } from "../packages/scripts/src/syntax-tree";

export const DRIZZLE_CONFIG = "apps/api/drizzle.config.ts";

// drizzle-kit uses public when the config names no schema filter.
const DRIZZLE_DEFAULT_SCHEMA_FILTER = ["public"];

export type DrizzleSchemaConfig = {
  /** Repository-relative schema files drizzle-kit reads. */
  readonly schemaFiles: readonly string[];
  /** Database schemas drizzle-kit generates migrations for. */
  readonly schemaFilter: readonly string[];
};

const stringList = (node: Node, key: string): string[] => {
  if (node.type !== "ArrayExpression") {
    return panic(`${DRIZZLE_CONFIG} ${key} must be an array literal`);
  }
  const values = node.elements.map((element) =>
    element?.type === "Literal" && typeof element.value === "string"
      ? element.value
      : panic(`${DRIZZLE_CONFIG} ${key} must list only string literals`),
  );
  if (values.length === 0) {
    return panic(`${DRIZZLE_CONFIG} ${key} names nothing`);
  }
  return values;
};

/**
 * The schema inputs and filter of the drizzle-kit config, read from its
 * syntax tree. Any form the reader cannot resolve statically (a constant, a
 * glob, a spread, a computed key) fails instead of dropping an entry.
 */
export const readDrizzleSchemaConfig = (root: string): DrizzleSchemaConfig => {
  const source = parseSource(
    DRIZZLE_CONFIG,
    readFileSync(path.join(root, DRIZZLE_CONFIG), "utf-8"),
  );
  const exported = source.program.body.find(
    (statement) => statement.type === "ExportDefaultDeclaration",
  );
  const declaration =
    exported?.type === "ExportDefaultDeclaration"
      ? exported.declaration
      : panic(`${DRIZZLE_CONFIG} has no default export`);
  const config =
    declaration.type === "CallExpression"
      ? declaration.arguments.at(0)
      : declaration;
  if (config?.type !== "ObjectExpression") {
    return panic(`${DRIZZLE_CONFIG} must export an object literal config`);
  }
  const properties = new Map<string, Node>();
  for (const property of config.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier"
    ) {
      properties.set(property.key.name, property.value);
    } else {
      panic(`${DRIZZLE_CONFIG} config must use plain keys`);
    }
  }
  const schema =
    properties.get("schema") ?? panic(`${DRIZZLE_CONFIG} lists no schema`);
  const schemaFiles = stringList(schema, "schema").map((file) =>
    file.endsWith(".ts")
      ? path.posix.normalize(path.posix.join("apps/api", file))
      : panic(`${DRIZZLE_CONFIG} schema entry ${file} is not a .ts file`),
  );
  const filter = properties.get("schemaFilter");
  return {
    schemaFiles,
    schemaFilter:
      filter === undefined
        ? DRIZZLE_DEFAULT_SCHEMA_FILTER
        : stringList(filter, "schemaFilter"),
  };
};
