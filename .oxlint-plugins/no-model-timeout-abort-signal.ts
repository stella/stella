// Model-call timeouts belong to the generation deadline contract. A raw
// AbortSignal.timeout in abortSignal is classified as cancellation/unknown,
// while deadlineMs produces the typed ModelDeadlineExceededError callers can
// present accurately. This rule covers direct generateTanStack* calls and a
// timeout nested anywhere beneath their inline abortSignal value, including
// AbortSignal.any([...]).

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  unwrapExpression,
} from "./utils.ts";

const containsAbortSignalTimeout = (
  value: unknown,
  seen = new WeakSet<object>(),
): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (
    node.type === "CallExpression" &&
    isMemberAccess(node.callee, "AbortSignal", "timeout")
  ) {
    return true;
  }
  // Walk down only: `parent` leads back up to the enclosing call and beyond,
  // where any other call's timeout would be reported against this one.
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(child)) {
      if (child.some((entry) => containsAbortSignalTimeout(entry, seen))) {
        return true;
      }
      continue;
    }
    if (isAstNode(child) && containsAbortSignalTimeout(child, seen)) {
      return true;
    }
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-model-timeout-abort-signal" },
  rules: {
    "no-model-timeout-abort-signal": {
      meta: {
        type: "problem",
        messages: {
          useDeadline:
            "Use deadlineMs for generateTanStack model-call timeouts; keep abortSignal for caller-owned cancellation.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return true;
          },
          CallExpression(node) {
            if (
              !isIdentifier(node.callee) ||
              !node.callee.name.startsWith("generateTanStack")
            ) {
              return;
            }
            const options = unwrapExpression(node.arguments.at(0));
            if (
              options?.type !== "ObjectExpression" ||
              !Array.isArray(options.properties)
            ) {
              return;
            }
            for (const property of options.properties) {
              if (
                !isAstNode(property) ||
                property.type !== "Property" ||
                getPropertyName(property.key) !== "abortSignal" ||
                !containsAbortSignalTimeout(property.value)
              ) {
                continue;
              }
              context.report({ node: property, messageId: "useDeadline" });
            }
          },
        };
      },
    },
  },
});
