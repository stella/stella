// A lookup table whose keys are a fixed set, typed `Record<string, V>`, does
// not notice when the set grows. A label or icon map for a verdict tier typed
// `Record<string, LucideIcon>` let a new tier compile with no entry, and the
// badge fell back to a default; `satisfies Record<ReviewVerdict, LucideIcon>`
// makes the same addition a type error at the map.
//
// Flagged: an object literal with only static keys (identifiers or string
// literals, no spread, computed key or method), bound to a `const`, typed
// `Record<string, V>` (also inside `Readonly<>` / `Partial<>`) by annotation
// or by `satisfies` (with or without `as const`), when the binding is a
// lookup table: read by a dynamic key (`map[key]`, `key in map`,
// `Object.hasOwn(map, key)`, `isOwnKey(map, key)`, `ownEntry(map, key)`, also
// through `as` / `!` wrappers; a plain `map[key] = value` write is not a read)
// or exported, by name or as the default, where its lookups are out of
// sight. An exported object whose keys are all CONSTANT_CASE names is a set
// of named constants read by property, not a lookup table, and is accepted.
//
//   const ICONS: Record<string, Icon> = { compliant: CheckIcon };  // flagged
//   const ICONS = { ... } as const satisfies Record<string, Icon>; // flagged
//   const ICONS = { ... } as const satisfies Record<Verdict, Icon>; // accepted
//
// oxlint plugins see syntax, not types: whether the keys belong to a union in
// scope is not checked. A map whose keys are an open set read off the wire
// (error codes, detector labels) keeps `Record<string, V>` with a disable
// comment saying so. `oxlint.config.ts` scopes the rule to the web and API
// apps' product source; sites that predate it are counted per file in
// scripts/design-lint-baseline.json, and each count may only fall.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  getCalleeName,
  isAstNode,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RECORD_WRAPPERS: ReadonlySet<string> = new Set(["Readonly", "Partial"]);
const OWN_KEY_CALLS: ReadonlySet<string> = new Set([
  "hasOwn",
  "hasOwnProperty",
  "isOwnKey",
  "ownEntry",
]);
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/u;

const typeArguments = (node: AstNode): unknown[] => {
  const args: unknown = node.typeArguments;
  if (!isAstNode(args) || !Array.isArray(args.params)) {
    return [];
  }
  return args.params;
};

const typeReferenceName = (node: AstNode): string | null => {
  const name: unknown = node.typeName;
  return node.type === "TSTypeReference" &&
    isAstNode(name) &&
    name.type === "Identifier" &&
    typeof name.name === "string"
    ? name.name
    : null;
};

/** `Record<string, V>`, alone or inside `Readonly<>` / `Partial<>`. */
const isStringKeyedRecord = (type: unknown): boolean => {
  if (!isAstNode(type)) {
    return false;
  }
  const name = typeReferenceName(type);
  const args = typeArguments(type);
  if (name !== null && RECORD_WRAPPERS.has(name) && args.length === 1) {
    return isStringKeyedRecord(args.at(0));
  }
  const key = args.at(0);
  return (
    name === "Record" &&
    args.length === 2 &&
    isAstNode(key) &&
    key.type === "TSStringKeyword"
  );
};

/** The keys of an object literal whose every member is a plain static key. */
const staticKeys = (node: AstNode): string[] | null => {
  const properties: unknown = node.properties;
  if (
    node.type !== "ObjectExpression" ||
    !Array.isArray(properties) ||
    properties.length === 0
  ) {
    return null;
  }
  const keys: string[] = [];
  for (const property of properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      property.computed === true ||
      property.method === true ||
      property.kind !== "init"
    ) {
      return null;
    }
    const key: unknown = property.key;
    if (!isAstNode(key)) {
      return null;
    }
    if (key.type === "Identifier" && typeof key.name === "string") {
      keys.push(key.name);
    } else if (key.type === "Literal" && typeof key.value === "string") {
      keys.push(key.value);
    } else {
      return null;
    }
  }
  return keys;
};

/**
 * The object literal a declarator binds, and whether a `Record<string, V>`
 * types it, read through `as const` and `satisfies`.
 */
const typedLiteral = (
  declarator: ESTree.VariableDeclarator,
): AstNode | null => {
  const id: unknown = declarator.id;
  if (!isAstNode(id) || id.type !== "Identifier") {
    return null;
  }
  const annotation: unknown = id.typeAnnotation;
  let typed =
    isAstNode(annotation) && isStringKeyedRecord(annotation.typeAnnotation);
  let value: unknown = declarator.init;
  while (
    isAstNode(value) &&
    (value.type === "TSAsExpression" || value.type === "TSSatisfiesExpression")
  ) {
    if (
      value.type === "TSSatisfiesExpression" &&
      isStringKeyedRecord(value.typeAnnotation)
    ) {
      typed = true;
    }
    value = value.expression;
  }
  return typed && isAstNode(value) && value.type === "ObjectExpression"
    ? value
    : null;
};

const isLiteralKey = (node: unknown): boolean => {
  const key = unwrapExpression(node);
  return (
    isAstNode(key) &&
    (staticStringValue(key) !== null ||
      (key.type === "Literal" && typeof key.value === "number"))
  );
};

// Wrappers that pass the map through unchanged: `(map as Record<...>)[key]`
// is still a read of `map`.
const VALUE_WRAPPERS: ReadonlySet<string> = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** Whether `identifier` is read as a lookup table, or exported by name. */
const lookupUse = (identifier: unknown): "lookup" | "export" | null => {
  if (!isAstNode(identifier)) {
    return null;
  }
  let value: AstNode = identifier;
  let parent: unknown = identifier.parent;
  while (
    isAstNode(parent) &&
    VALUE_WRAPPERS.has(parent.type) &&
    parent.expression === value
  ) {
    value = parent;
    parent = parent.parent;
  }
  if (!isAstNode(parent)) {
    return null;
  }
  if (
    parent.type === "MemberExpression" &&
    parent.object === value &&
    parent.computed === true &&
    !isLiteralKey(parent.property)
  ) {
    // `map[key] = value` only fills the table; a compound assignment reads it.
    const target: unknown = parent.parent;
    const fillsOnly =
      isAstNode(target) &&
      target.type === "AssignmentExpression" &&
      target.operator === "=" &&
      target.left === parent;
    return fillsOnly ? null : "lookup";
  }
  if (
    parent.type === "BinaryExpression" &&
    parent.operator === "in" &&
    parent.right === value &&
    !isLiteralKey(parent.left)
  ) {
    return "lookup";
  }
  if (parent.type === "CallExpression") {
    const args: unknown = parent.arguments;
    // `Object.hasOwn` and a bare `isOwnKey` alike: the last name decides.
    const name = getCalleeName(parent.callee)?.split(".").at(-1) ?? null;
    if (
      Array.isArray(args) &&
      args.at(0) === value &&
      !isLiteralKey(args.at(1)) &&
      name !== null &&
      OWN_KEY_CALLS.has(name)
    ) {
      return "lookup";
    }
  }
  return parent.type === "ExportSpecifier" ||
    parent.type === "ExportDefaultDeclaration"
    ? "export"
    : null;
};

const isExportedDeclaration = (declarator: ESTree.VariableDeclarator) => {
  const declaration: unknown = declarator.parent;
  return (
    isAstNode(declaration) &&
    isAstNode(declaration.parent) &&
    declaration.parent.type === "ExportNamedDeclaration"
  );
};

export default eslintCompatPlugin({
  meta: { name: "exhaustive-union-map" },
  rules: {
    "exhaustive-union-map": {
      meta: {
        type: "problem",
        messages: {
          stringKeyedMap:
            "`{{name}}` maps a fixed set of keys but is typed Record<string, …>, so a member added to the union it covers compiles without an entry here. Key it by that union: `satisfies Record<Union, …>`.",
        },
      },
      createOnce(context) {
        return {
          VariableDeclarator(node) {
            // A `let` table is filled as the program runs; its keys are open.
            const declaration: unknown = node.parent;
            if (!isAstNode(declaration) || declaration.kind !== "const") {
              return;
            }
            const literal = typedLiteral(node);
            const keys = literal === null ? null : staticKeys(literal);
            if (keys === null) {
              return;
            }
            const exported = isExportedDeclaration(node);
            let lookedUp = false;
            let exportedByName = false;
            for (const variable of context.sourceCode.getDeclaredVariables(
              node,
            )) {
              for (const reference of variable.references) {
                const use = lookupUse(reference.identifier);
                lookedUp ||= use === "lookup";
                exportedByName ||= use === "export";
              }
            }
            const namedConstants = keys.every((key) => CONSTANT_NAME.test(key));
            if (
              !lookedUp &&
              (!(exported || exportedByName) || namedConstants)
            ) {
              return;
            }
            // First-week rollout: only declarations on lines this change
            // touched (scripts/guard-rollouts/exhaustive-union-map.json).
            const start = context.sourceCode.getLocFromIndex(
              node.range[0],
            ).line;
            const end = context.sourceCode.getLocFromIndex(
              node.range[1] - 1,
            ).line;
            let enforced = false;
            for (let line = start; line <= end && !enforced; line++) {
              enforced = guardEnforcesLine({
                guard: "exhaustive-union-map",
                file: filenameForContext(context),
                line,
              });
            }
            if (!enforced) {
              return;
            }
            const id: unknown = node.id;
            context.report({
              node,
              messageId: "stringKeyedMap",
              data: {
                name:
                  isAstNode(id) && typeof id.name === "string"
                    ? id.name
                    : "map",
              },
            });
          },
        };
      },
    },
  },
});
