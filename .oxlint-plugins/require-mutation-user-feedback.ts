import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { getCalleeName, getPropertyName, isAstNode } from "./utils.ts";

const callsNamed = (root: unknown, name: string): boolean => {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!isAstNode(value) || seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (
      value.type === "CallExpression" &&
      (getCalleeName(value.callee)?.split(".").at(-1) === name ||
        (name === "notifyUserError" &&
          getCalleeName(value.callee)?.split(".").at(-1)?.startsWith("notify")))
    ) {
      return true;
    }
    return Object.entries(value).some(
      ([key, child]) => key !== "parent" && visit(child),
    );
  };
  return visit(root);
};

const property = (node: AstNode, name: string): AstNode | undefined => {
  const properties = Array.isArray(node.properties) ? node.properties : [];
  return properties.find(
    (candidate): candidate is AstNode =>
      isAstNode(candidate) &&
      candidate.type === "Property" &&
      getPropertyName(candidate.key) === name,
  );
};

const callerOwnsFeedback = (node: AstNode): boolean => {
  const meta = property(node, "meta");
  if (
    !meta ||
    !isAstNode(meta.value) ||
    meta.value.type !== "ObjectExpression"
  ) {
    return false;
  }
  const feedback = property(meta.value, "feedback");
  return (
    feedback !== undefined &&
    isAstNode(feedback.value) &&
    feedback.value.type === "Literal" &&
    feedback.value.value === "caller"
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-mutation-user-feedback" },
  rules: {
    "require-mutation-user-feedback": {
      meta: {
        type: "problem",
        messages: {
          missing:
            "A user-initiated mutation must route failures through notifyUserError, or declare meta.feedback as caller and handle feedback at every caller.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (
              getCalleeName(node.callee)?.split(".").at(-1) !== "useMutation"
            ) {
              return;
            }
            const options = Array.isArray(node.arguments)
              ? node.arguments.at(0)
              : undefined;
            if (
              !isAstNode(options) ||
              options.type !== "ObjectExpression" ||
              callerOwnsFeedback(options)
            ) {
              return;
            }
            const onError = property(options, "onError");
            if (
              onError &&
              callsNamed(onError.value, "captureError") &&
              !callsNamed(onError.value, "notifyUserError")
            ) {
              context.report({ node: onError, messageId: "missing" });
            }
          },
        };
      },
    },
  },
});
