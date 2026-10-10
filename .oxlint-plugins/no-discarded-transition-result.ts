import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  canonicalModuleId,
  isAstNode,
  repoRelativeFilename,
  resolveImportedExpression,
  unwrapExpression,
} from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-discarded-transition-result" },
  rules: {
    "no-discarded-transition-result": {
      meta: {
        type: "problem",
        messages: {
          discarded:
            "Handle or return transition's Transitioned or Stale result. Discarding it reports a stale update as success.",
        },
        schema: [],
      },
      createOnce(context) {
        const isTransition = (expression: unknown): boolean => {
          const value = unwrapExpression(expression);
          if (value?.type === "AwaitExpression") {
            return isTransition(value.argument);
          }
          if (value?.type !== "CallExpression") {
            return false;
          }
          const imported = resolveImportedExpression(context, value.callee);
          return (
            imported?.imported === "transition" &&
            canonicalModuleId(
              imported.source,
              repoRelativeFilename(context),
            ).endsWith("apps/api/src/lib/db/transitions")
          );
        };
        return {
          ExpressionStatement(node) {
            if (isTransition(node.expression)) {
              context.report({ node, messageId: "discarded" });
            }
          },
          UnaryExpression(node) {
            if (node.operator === "void" && isTransition(node.argument)) {
              context.report({ node, messageId: "discarded" });
            }
          },
          SequenceExpression(node) {
            const expressions = node.expressions;
            for (const expression of expressions.slice(0, -1)) {
              if (isAstNode(expression) && isTransition(expression)) {
                context.report({ node: expression, messageId: "discarded" });
              }
            }
          },
        };
      },
    },
  },
});
