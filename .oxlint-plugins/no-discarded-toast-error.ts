import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  resolveImportedExpression,
  unwrapExpression,
} from "./utils.ts";

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
                ancestor.type === "FunctionExpression"
              ) {
                const parent = ancestor.parent;
                const errorCallback =
                  isAstNode(parent) &&
                  ((parent.type === "Property" &&
                    getPropertyName(parent.key) === "onError") ||
                    (parent.type === "CallExpression" &&
                      isAstNode(parent.callee) &&
                      parent.callee.type === "MemberExpression" &&
                      getPropertyName(parent.callee.property) === "catch"));
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
