import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  type ScopeContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  resolveImportedExpression,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const isErrorCallbackUse = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<AstNode>(),
): boolean => {
  if (!isAstNode(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type === "Property") {
    return getPropertyName(parent.key) === "onError" && parent.value === node;
  }
  if (parent.type === "CallExpression") {
    return (
      isAstNode(parent.callee) &&
      parent.callee.type === "MemberExpression" &&
      getPropertyName(parent.callee.property) === "catch" &&
      Array.isArray(parent.arguments) &&
      parent.arguments.at(0) === node
    );
  }
  if (unwrapExpression(parent) === node) {
    return isErrorCallbackUse(context, parent, seen);
  }
  const identifier =
    parent.type === "VariableDeclarator" && parent.init === node
      ? parent.id
      : node.type === "FunctionDeclaration"
        ? node.id
        : null;
  if (!isIdentifierReference(identifier)) {
    return false;
  }
  const variable = resolveVariable(context, identifier);
  if (variable === null || !isSingleAssignment(variable)) {
    return false;
  }
  return variable.references.some((reference) =>
    isErrorCallbackUse(context, reference.identifier, seen),
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-discarded-toast-error" },
  rules: {
    "no-discarded-toast-error": {
      meta: {
        type: "problem",
        messages: {
          discarded:
            "Pass the original caught error to notifyUserError; flattening or discarding it loses typed refusal handling.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const binding = resolveImportedExpression(context, node.callee);
            if (binding?.imported !== "notifyUserError") {
              return;
            }
            const error = unwrapExpression(node.arguments.at(0));
            if (error?.type === "CallExpression") {
              const flattened = resolveImportedExpression(
                context,
                error.callee,
              );
              if (
                flattened?.imported === "userErrorFromThrown" ||
                flattened?.imported === "userErrorMessage"
              ) {
                context.report({ node, messageId: "discarded" });
              }
              return;
            }
            const missing =
              error === null ||
              isIdentifier(error, "undefined") ||
              (error.type === "UnaryExpression" && error.operator === "void");
            if (!missing) {
              return;
            }
            let ancestor: unknown = node.parent;
            while (isAstNode(ancestor)) {
              if (ancestor.type === "CatchClause") {
                context.report({ node, messageId: "discarded" });
                return;
              }
              if (
                ancestor.type === "ArrowFunctionExpression" ||
                ancestor.type === "FunctionExpression" ||
                ancestor.type === "FunctionDeclaration"
              ) {
                const errorCallback = isErrorCallbackUse(context, ancestor);
                if (errorCallback) {
                  context.report({ node, messageId: "discarded" });
                }
                return;
              }
              ancestor = ancestor.parent;
            }
          },
        };
      },
    },
  },
});
