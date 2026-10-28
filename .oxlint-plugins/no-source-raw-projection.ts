import { type Context, eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const LOSSY_OPERATIONS = new Set([
  "filter",
  "pick",
  "pickBy",
  "omit",
  "omitBy",
  "remove",
]);

const calledName = (context: Context, node: AstNode): string | null => {
  const imported = resolveImportedExpressionForEnforcement(context, node);
  if (imported !== null) {
    return imported.imported;
  }
  if (node.type === "MemberExpression") {
    return getPropertyName(node.property);
  }
  return node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;
};

const returnedValues = (value: unknown): unknown[] => {
  if (!isAstNode(value)) {
    return [];
  }
  if (value.type === "ReturnStatement") {
    return [value.argument];
  }
  if (
    [
      "ArrowFunctionExpression",
      "FunctionExpression",
      "FunctionDeclaration",
    ].includes(value.type)
  ) {
    return [];
  }
  const values: unknown[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent") {
      continue;
    }
    for (const candidate of Array.isArray(child) ? child : [child]) {
      values.push(...returnedValues(candidate));
    }
  }
  return values;
};

const directLossyCall = (context: Context, node: AstNode): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee)) {
    return false;
  }
  if (LOSSY_OPERATIONS.has(calledName(context, callee) ?? "")) {
    return true;
  }
  if (
    callee.type !== "MemberExpression" ||
    getPropertyName(callee.property) !== "stringify" ||
    !Array.isArray(node.arguments) ||
    node.arguments.length < 2
  ) {
    return false;
  }
  const replacer = unwrapExpression(node.arguments.at(1));
  return (
    isAstNode(replacer) &&
    !(replacer.type === "Literal" && replacer.value === null)
  );
};

const omittedRestPattern = (node: AstNode): AstNode | null => {
  const pattern = node.id;
  return isAstNode(pattern) &&
    pattern.type === "ObjectPattern" &&
    Array.isArray(pattern.properties) &&
    pattern.properties.length > 1 &&
    pattern.properties.some(
      (property) => isAstNode(property) && property.type === "RestElement",
    )
    ? pattern
    : null;
};

const projectionChildren = (node: AstNode): unknown[] => {
  if (
    [
      "ArrowFunctionExpression",
      "FunctionExpression",
      "FunctionDeclaration",
    ].includes(node.type)
  ) {
    const body = unwrapExpression(node.body);
    return body?.type === "BlockStatement" ? returnedValues(body) : [body];
  }
  const children: unknown[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (
      key === "parent" ||
      (node.type === "MemberExpression" &&
        key === "property" &&
        node.computed !== true) ||
      (node.type === "Property" && key === "key" && node.computed !== true)
    ) {
      continue;
    }
    children.push(...(Array.isArray(child) ? child : [child]));
  }
  return children;
};

type BindingProjectionOptions = {
  context: Context;
  node: AstNode;
  seen: Set<unknown>;
};

const bindingProjection = ({
  context,
  node,
  seen,
}: BindingProjectionOptions): AstNode | null => {
  if (!isIdentifierReference(node)) {
    return null;
  }
  const binding = resolveVariable(context, node);
  for (const definition of binding?.defs ?? []) {
    const declaration: unknown = definition.node;
    if (!isAstNode(declaration)) {
      continue;
    }
    const omitted = omittedRestPattern(declaration);
    if (omitted !== null) {
      return omitted;
    }
    let value: unknown = null;
    if (definition.type === "Variable") {
      value = declaration.init;
    } else if (definition.type === "FunctionName") {
      value = declaration;
    }
    const projection = lossyProjection(context, value, seen);
    if (projection !== null) {
      return projection;
    }
  }
  for (const reference of binding?.references ?? []) {
    let parent: unknown = reference.identifier.parent;
    while (isAstNode(parent) && parent.type === "MemberExpression") {
      parent = parent.parent;
    }
    if (
      isAstNode(parent) &&
      parent.type === "UnaryExpression" &&
      parent.operator === "delete"
    ) {
      return parent;
    }
  }
  return null;
};

/** Follow local bindings so naming a projection first does not hide it. */
const lossyProjection = (
  context: Context,
  value: unknown,
  seen = new Set<unknown>(),
): AstNode | null => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (directLossyCall(context, node)) {
    return node;
  }
  const binding = bindingProjection({ context, node, seen });
  if (binding !== null) {
    return binding;
  }
  for (const child of projectionChildren(node)) {
    const projection = lossyProjection(context, child, seen);
    if (projection !== null) {
      return projection;
    }
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-source-raw-projection" },
  rules: {
    "no-source-raw-projection": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          lossyRaw:
            "Retain the complete publisher payload in sourceRaw; filter, pick, omit, rest omission, delete and JSON replacers cannot project the raw archive.",
        },
      },
      createOnce(context) {
        const check = (value: unknown, sink: unknown) => {
          if (isAstNode(sink) && lossyProjection(context, value) !== null) {
            context.report({ node: sink, messageId: "lossyRaw" });
          }
        };
        return {
          Property(node) {
            if (
              isAstNode(node.parent) &&
              node.parent.type === "ObjectExpression" &&
              getPropertyName(node.key) === "sourceRaw"
            ) {
              check(node.value, node);
            }
          },
          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (
              target?.type === "MemberExpression" &&
              getPropertyName(target.property) === "sourceRaw"
            ) {
              check(node.right, node);
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              isAstNode(callee) &&
              calledName(context, callee) === "encodeSourceRawEnvelope" &&
              Array.isArray(node.arguments)
            ) {
              check(node.arguments.at(0), node);
            }
          },
        };
      },
    },
  },
});
