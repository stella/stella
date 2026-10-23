// Timeout labels are telemetry identities, never runtime descriptions.
//
// Flags a `label` passed to `withTimeout` or a timeout-named wrapper unless it
// is a string literal or an interpolation-free template literal. This keeps
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
            "Timeout labels become telemetry identity and must be static string literals without substitutions.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const name = callName(node.callee);
            if (name === null || !/timeout/iu.test(name)) {
              return;
            }
            for (const argument of node.arguments) {
              const value = labelValue(argument);
              if (isAstNode(value) && !isStaticString(value)) {
                context.report({ node: value, messageId: "dynamic" });
              }
            }
          },
        };
      },
    },
  },
});
