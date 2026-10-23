// Timeout labels are telemetry identities, never runtime descriptions.
//
// Flags a `label` passed to `withTimeout` or a timeout-named wrapper unless it
// is a string literal, an interpolation-free template literal, or a lookup in
// a module-level `as const` table of literal strings. This keeps
// IDs, URLs, names, and other unbounded values out of issue identity.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  staticStringValue,
} from "./utils.ts";

const isStaticString = (node: unknown): boolean =>
  staticStringValue(node) !== null;

const unwrapSatisfies = (node: unknown): unknown =>
  isAstNode(node) && node.type === "TSSatisfiesExpression"
    ? unwrapSatisfies(node.expression)
    : node;

const constAssertedObject = (node: unknown): unknown => {
  const expression = unwrapSatisfies(node);
  if (!isAstNode(expression) || expression.type !== "TSAsExpression") {
    return null;
  }
  const annotation = expression.typeAnnotation;
  if (
    !isAstNode(annotation) ||
    annotation.type !== "TSTypeReference" ||
    !isIdentifier(annotation.typeName) ||
    annotation.typeName.name !== "const"
  ) {
    return null;
  }
  return unwrapSatisfies(expression.expression);
};

const staticLabelTableName = (statement: unknown): string | null => {
  if (
    !isAstNode(statement) ||
    statement.type !== "VariableDeclaration" ||
    statement.kind !== "const" ||
    !Array.isArray(statement.declarations) ||
    statement.declarations.length !== 1
  ) {
    return null;
  }
  const declaration = statement.declarations[0];
  const object = constAssertedObject(declaration.init);
  if (
    !isIdentifier(declaration.id) ||
    !isAstNode(object) ||
    object.type !== "ObjectExpression" ||
    !Array.isArray(object.properties) ||
    object.properties.length === 0 ||
    object.properties.some(
      (property) =>
        property.type !== "Property" ||
        property.kind !== "init" ||
        property.method ||
        !isStaticString(property.value),
    )
  ) {
    return null;
  }
  return declaration.id.name;
};

const callName = (callee: unknown): string | null => {
  if (!isAstNode(callee)) {
    return null;
  }
  if (isIdentifier(callee)) {
    return callee.name;
  }
  if (callee.type === "MemberExpression") {
    return getPropertyName(callee.property);
  }
  return null;
};

const labelValue = (argument: unknown): unknown => {
  if (
    !isAstNode(argument) ||
    argument.type !== "ObjectExpression" ||
    !Array.isArray(argument.properties)
  ) {
    return undefined;
  }
  for (const property of argument.properties) {
    if (
      property.type === "Property" &&
      getPropertyName(property.key) === "label"
    ) {
      return property.value;
    }
  }
  return undefined;
};

export default eslintCompatPlugin({
  meta: { name: "require-static-timeout-label" },
  rules: {
    "require-static-timeout-label": {
      meta: {
        type: "problem",
        messages: {
          dynamic:
            "Timeout labels become telemetry identity; use a string literal or a module-level `as const` table of literal labels indexed by a closed key.",
        },
        schema: [],
      },
      createOnce(context) {
        const staticLabelTables = new Set<string>();
        return {
          Program(node) {
            for (const statement of node.body) {
              const declaration =
                statement.type === "ExportNamedDeclaration"
                  ? statement.declaration
                  : statement;
              const name = staticLabelTableName(declaration);
              if (name !== null) {
                staticLabelTables.add(name);
              }
            }
          },
          CallExpression(node) {
            const name = callName(node.callee);
            if (name === null || !/timeout/iu.test(name)) {
              return;
            }
            for (const argument of node.arguments) {
              const value = labelValue(argument);
              const isStaticTableLookup =
                isAstNode(value) &&
                value.type === "MemberExpression" &&
                isIdentifier(value.object) &&
                staticLabelTables.has(value.object.name);
              if (
                isAstNode(value) &&
                !isStaticString(value) &&
                !isStaticTableLookup
              ) {
                context.report({ node: value, messageId: "dynamic" });
              }
            }
          },
        };
      },
    },
  },
});
