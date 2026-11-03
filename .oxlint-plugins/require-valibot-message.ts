import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getCalleeName,
  isAstNode,
  isIdentifier,
  staticStringValue,
} from "./utils.ts";

// The position of each validator's message argument: value validators take
// their bound first, message-only validators take the message alone.
const MESSAGE_ARGUMENT_INDEX = new Map([
  ["v.email", 0],
  ["v.integer", 0],
  ["v.length", 1],
  ["v.maxLength", 1],
  ["v.maxValue", 1],
  ["v.minLength", 1],
  ["v.minValue", 1],
  ["v.nonEmpty", 0],
  ["v.regex", 1],
  ["v.url", 0],
  ["v.uuid", 0],
]);

// `undefined` and a blank literal compile but leave Valibot's default English
// diagnostic in place, so they count as no message.
const providesMessage = (argument: unknown): boolean =>
  argument !== undefined &&
  !isIdentifier(argument, "undefined") &&
  staticStringValue(argument)?.trim() !== "";

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
            const index = MESSAGE_ARGUMENT_INDEX.get(
              getCalleeName(node.callee) ?? "",
            );
            if (index === undefined) {
              return;
            }
            const argument = Array.isArray(node.arguments)
              ? node.arguments.at(index)
              : undefined;
            if (!providesMessage(argument)) {
              context.report({ node, messageId: "missingMessage" });
            }
          },
        };
      },
    },
  },
});
