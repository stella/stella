// On the chat stream and message paths a key is usually read off the wire: an
// event type, a part type, a tool name. `key in table` is true for every name
// an object inherits (`constructor`, `toString`, `__proto__`), so a newer
// server's unknown name reads as a known one. Over-approximate: any `in` whose
// key is not a literal is reported, and the own-key helpers replace it.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, unwrapExpression } from "./utils.ts";

const isLiteralKey = (node: unknown): boolean => {
  const key = unwrapExpression(node);
  return (
    isAstNode(key) &&
    ((key.type === "Literal" &&
      (typeof key.value === "string" || typeof key.value === "number")) ||
      key.type === "PrivateIdentifier" ||
      (key.type === "TemplateLiteral" &&
        Array.isArray(key.expressions) &&
        key.expressions.length === 0))
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-dynamic-key-in-operator" },
  rules: {
    "no-dynamic-key-in-operator": {
      meta: {
        type: "problem",
        messages: {
          dynamicKeyIn:
            "`key in table` also matches inherited names such as `constructor`; use isOwnKey(table, key) or ownEntry(table, key) from @stll/api-contract/own-key.",
        },
      },
      createOnce(context) {
        return {
          BinaryExpression(node) {
            if (node.operator !== "in" || isLiteralKey(node.left)) {
              return;
            }
            context.report({ node, messageId: "dynamicKeyIn" });
          },
        };
      },
    },
  },
});
