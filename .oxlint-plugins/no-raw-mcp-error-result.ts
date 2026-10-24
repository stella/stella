import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const isErrorValueName = (name: string): boolean =>
  name
    .replaceAll(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((part) => part === "cause" || part === "err" || part === "error");

const containsErrorValueName = (value: AstNode): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (isIdentifier(node)) {
    return isErrorValueName(node.name);
  }
  if (node.type !== "MemberExpression") {
    return false;
  }
  const property = memberPropertyName(node);
  return (
    (property !== null && isErrorValueName(property)) ||
    (isAstNode(node.object) && containsErrorValueName(node.object))
  );
};

const isInternalErrorMessage = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  return (
    node?.type === "MemberExpression" &&
    memberPropertyName(node) === "message" &&
    isAstNode(node.object) &&
    containsErrorValueName(node.object)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-mcp-error-result" },
  rules: {
    "no-raw-mcp-error-result": {
      meta: {
        type: "problem",
        messages: {
          internalMessage:
            "Do not expose an internal error message in an MCP tool result; pass the error to internalFailureResult instead.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (
              !isIdentifier(unwrapExpression(node.callee), "errorResult") ||
              !Array.isArray(node.arguments) ||
              !isInternalErrorMessage(node.arguments.at(0))
            ) {
              return;
            }
            context.report({ node, messageId: "internalMessage" });
          },
        };
      },
    },
  },
});
