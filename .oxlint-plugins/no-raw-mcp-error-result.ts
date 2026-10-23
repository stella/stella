// MCP failures must preserve the structured envelope and keep implementation
// details out of tool output. This rule covers direct raw error-message
// unwrapping at errorResult call sites; semantic aliases outside the call
// expression remain outside this deliberately narrow syntax guard.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isIdentifier, unwrapExpression } from "./utils.ts";

const RAW_ERROR_BINDINGS = new Set(["cause", "err", "error"]);

const isRawErrorMessage = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (
    node?.type !== "MemberExpression" ||
    getPropertyName(node.property) !== "message"
  ) {
    return false;
  }

  const owner = unwrapExpression(node.object);
  return (
    (isIdentifier(owner) && RAW_ERROR_BINDINGS.has(owner.name)) ||
    (owner?.type === "MemberExpression" &&
      getPropertyName(owner.property) === "error")
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-mcp-error-result" },
  rules: {
    "no-raw-mcp-error-result": {
      meta: {
        type: "problem",
        messages: {
          rawMessage:
            "Pass the error to internalFailureResult instead of exposing its message through errorResult.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              !isIdentifier(callee, "errorResult") ||
              !isRawErrorMessage(node.arguments.at(0))
            ) {
              return;
            }

            context.report({ node, messageId: "rawMessage" });
          },
        };
      },
    },
  },
});
