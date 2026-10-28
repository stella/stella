import { eslintCompatPlugin } from "@oxlint/plugins";

import { getCalleeName, isAstNode } from "./utils.ts";

const VALUE_VALIDATORS = new Set([
  "v.length",
  "v.maxLength",
  "v.maxValue",
  "v.minLength",
  "v.minValue",
  "v.regex",
]);
const MESSAGE_ONLY_VALIDATORS = new Set([
  "v.email",
  "v.integer",
  "v.nonEmpty",
  "v.url",
  "v.uuid",
]);

const isInsideFallback = (node: unknown): boolean => {
  let current = node;
  while (isAstNode(current)) {
    const parent = current.parent;
    if (!isAstNode(parent)) {
      return false;
    }
    if (
      parent.type === "CallExpression" &&
      getCalleeName(parent.callee) === "v.fallback"
    ) {
      return true;
    }
    current = parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "require-valibot-message" },
  rules: {
    "require-valibot-message": {
      meta: {
        type: "problem",
        messages: {
          missingMessage:
            "User-facing Valibot validators must receive a translated message.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            // Search-param decoders intentionally discard invalid input through
            // fallback; their validator diagnostics can never reach a person.
            if (isInsideFallback(node)) {
              return;
            }
            const callee = getCalleeName(node.callee);
            const argumentsCount = Array.isArray(node.arguments)
              ? node.arguments.length
              : 0;
            const missing =
              (MESSAGE_ONLY_VALIDATORS.has(callee ?? "") &&
                argumentsCount === 0) ||
              (VALUE_VALIDATORS.has(callee ?? "") && argumentsCount < 2);
            if (missing) {
              context.report({ node, messageId: "missingMessage" });
            }
          },
        };
      },
    },
  },
});
