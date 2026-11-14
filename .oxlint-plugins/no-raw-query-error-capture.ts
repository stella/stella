import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, isIdentifier } from "./utils.ts";

const isQueryFunction = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  let current = node.parent;
  while (isAstNode(current)) {
    const parent = current.parent;
    if (
      (current.type === "ArrowFunctionExpression" ||
        current.type === "FunctionExpression") &&
      isAstNode(parent) &&
      parent.type === "Property" &&
      isIdentifier(parent.key, "queryFn")
    ) {
      return true;
    }
    current = parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-query-error-capture" },
  rules: {
    "no-raw-query-error-capture": {
      meta: {
        type: "problem",
        messages: {
          rawCapture:
            "Query functions must report failures through the query error owner, not call captureError directly.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              isIdentifier(callee.property, "captureError") &&
              isQueryFunction(node)
            ) {
              context.report({ node, messageId: "rawCapture" });
            }
          },
        };
      },
    },
  },
});
