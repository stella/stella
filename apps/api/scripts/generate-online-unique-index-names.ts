import { panic } from "better-result";
import { readFileSync } from "node:fs";

import {
  type Node,
  parseSource,
  type VariableDeclaration,
} from "@stll/scripts/src/syntax-tree";

import {
  formattedLikeRepository,
  writeOrCheckArtifacts,
} from "../../../scripts/generated-artifacts";
import { REWRITTEN_MIGRATION_INDEXES } from "../src/lib/db/migration-history";
import type { RequiredMigrationIndex } from "../src/lib/db/migration-history";

const isUniqueInventoryFilter = (node: Node) => {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.object.type !== "Identifier" ||
    node.callee.object.name !== "REWRITTEN_MIGRATION_INDEXES" ||
    node.callee.property.type !== "Identifier" ||
    node.callee.property.name !== "filter" ||
    node.arguments.length !== 1
  ) {
    return false;
  }
  const predicate = node.arguments.at(0);
  if (
    predicate?.type !== "ArrowFunctionExpression" ||
    predicate.params.length !== 1 ||
    predicate.body.type !== "Identifier"
  ) {
    return false;
  }
  const parameter = predicate.params.at(0);
  if (
    parameter?.type !== "ObjectPattern" ||
    parameter.properties.length !== 1
  ) {
    return false;
  }
  const binding = parameter.properties.at(0);
  return (
    binding?.type === "Property" &&
    binding.shorthand &&
    binding.value.type === "Identifier" &&
    binding.value.name === "isUnique" &&
    predicate.body.name === "isUnique"
  );
};

/** A top-level variable statement, exported or not. */
const exportedVariables = (
  statement: Node,
): VariableDeclaration | undefined => {
  if (statement.type === "VariableDeclaration") {
    return statement;
  }
  if (
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration"
  ) {
    return statement.declaration;
  }
  return undefined;
};

/** An identifier or string key's name. */
const propertyKeyName = (key: Node) => {
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
};

/** A string literal or a template literal without substitutions. */
const stringLiteralLike = (node: Node) => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

type OnlineUniqueIndexNamesOptions = {
  source: string;
  rewrittenIndexes: readonly RequiredMigrationIndex[];
};

/** Read declarations without importing their generated name projection. */
export const deriveOnlineUniqueIndexNames = ({
  source,
  rewrittenIndexes,
}: OnlineUniqueIndexNamesOptions) => {
  const ast = parseSource("online-unique-indexes.ts", source).program;
  const declarations = new Map<string, Node>();
  for (const statement of ast.body) {
    const variables = exportedVariables(statement);
    for (const { id, init } of variables?.declarations ?? []) {
      if (id.type === "Identifier" && init !== null) {
        declarations.set(id.name, init);
      }
    }
  }
  const namesOf = (node: Node, seen = new Set<string>()): string[] => {
    if (
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression"
    ) {
      return namesOf(node.expression, seen);
    }
    if (node.type === "SpreadElement") {
      return namesOf(node.argument, seen);
    }
    if (node.type === "Identifier") {
      if (seen.has(node.name)) {
        return panic(`Cyclic online index declaration: ${node.name}`);
      }
      const declaration = declarations.get(node.name);
      if (declaration === undefined) {
        return panic(`Missing online index declaration: ${node.name}`);
      }
      return namesOf(declaration, new Set([...seen, node.name]));
    }
    if (node.type === "ArrayExpression") {
      return node.elements.flatMap((element) =>
        element === null
          ? panic("Online index names cannot skip an array element")
          : namesOf(element, seen),
      );
    }
    if (isUniqueInventoryFilter(node)) {
      return rewrittenIndexes
        .filter(({ isUnique }) => isUnique)
        .map(({ name }) => name);
    }
    if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (
          property.type !== "Property" ||
          property.kind !== "init" ||
          property.method ||
          property.shorthand ||
          property.computed ||
          propertyKeyName(property.key) !== "name"
        ) {
          continue;
        }
        const name = stringLiteralLike(property.value);
        if (name !== undefined) {
          return [name];
        }
        break;
      }
    }
    return panic(
      `Online index name must be a declaration literal: ${source.slice(node.start, node.end)}`,
    );
  };
  const declarationNames = (name: string) => {
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return panic(`Missing online index declaration: ${name}`);
    }
    return namesOf(declaration);
  };
  const executableNames = declarationNames("EXECUTABLE_ONLINE_UNIQUE_INDEXES");
  const names = declarationNames("ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS");
  const aliases = new Map<string, string>();
  for (const name of names.toSorted()) {
    const alias = name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(alias)) {
      return panic(`Invalid online index export: ${name}`);
    }
    if (aliases.has(alias)) {
      return panic(`Duplicate online index export: ${alias}`);
    }
    aliases.set(alias, name);
  }
  const renderMap = (name: string, included: ReadonlySet<string>) =>
    `export const ${name} = {${[...aliases]
      .filter(([, value]) => included.has(value))
      .map(([alias]) => alias)
      .join(",")}} as const;`;
  return [
    "// GENERATED by apps/api/scripts/generate-online-unique-index-names.ts. Do not edit.",
    ...[...aliases].map(
      ([alias, name]) => `const ${alias} = ${JSON.stringify(name)};`,
    ),
    renderMap("EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES", new Set(executableNames)),
    renderMap("ONLINE_UNIQUE_INDEX_NAMES", new Set(names)),
    "",
  ].join("\n");
};

if (import.meta.main) {
  const owner = new URL("../src/db/online-unique-indexes.ts", import.meta.url);
  const source = readFileSync(owner, "utf-8");
  const begin = "// BEGIN GENERATED ONLINE UNIQUE INDEX NAMES";
  const end = "// END GENERATED ONLINE UNIQUE INDEX NAMES";
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (
    start === -1 ||
    finish <= start ||
    source.includes(begin, start + begin.length) ||
    source.includes(end, finish + end.length)
  ) {
    panic("Online unique index name projection needs exactly one owner block");
  }
  const projection = deriveOnlineUniqueIndexNames({
    source,
    rewrittenIndexes: REWRITTEN_MIGRATION_INDEXES,
  });
  const contents = await formattedLikeRepository(
    `${source.slice(0, start)}${begin}\n${projection}${source.slice(finish)}`,
    "ts",
  );
  process.exitCode = await writeOrCheckArtifacts(
    [{ path: owner.pathname, contents }],
    {
      write: process.argv.includes("--write"),
      matched: "the online unique index declarations",
    },
  );
}
