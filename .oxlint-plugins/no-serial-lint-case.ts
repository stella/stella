import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isPerIterationLoopPosition,
  LOOP_NODE_TYPES,
} from "./utils.ts";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const runsOncePerIteration = (node: unknown): boolean => {
  let child = node;
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (LOOP_NODE_TYPES.has(current.type)) {
      if (isPerIterationLoopPosition(current, child)) {
        return true;
      }
    } else if (FUNCTION_TYPES.has(current.type)) {
      return false;
    }
    child = current;
    current = current.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-serial-lint-case" },
  rules: {
    "no-serial-lint-case": {
      meta: {
        type: "problem",
        messages: {
          serialLintCase:
            "Await lint cases together (Promise.all): cases with one configuration share one oxlint run, while a serial await starts one oxlint process per case and turns test time into a wall-clock cliff.",
        },
      },
      createOnce(context) {
        return {
          AwaitExpression(node) {
            const call = node.argument;
            if (
              !isAstNode(call) ||
              call.type !== "CallExpression" ||
              !isAstNode(call.callee) ||
              call.callee.type !== "Identifier" ||
              !call.callee.name.startsWith("lint") ||
              !runsOncePerIteration(node)
            ) {
              return;
            }
            context.report({ node, messageId: "serialLintCase" });
          },
        };
      },
    },
  },
});
