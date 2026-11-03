/**
 * Browser specs navigate the booted app through
 * `apps/web/e2e/helpers/decision-reader.ts`, never through a raw
 * `history.pushState`. A signed-in user's decision page first shows a gated
 * reader as the Suspense fallback and then mounts the authenticated reader in
 * its place; `openMemberDecision` waits for the reader that stays, so a spec
 * cannot measure or click a node that is about to be detached.
 *
 * Syntax only: a push reached through an alias of `history` is not seen.
 */
import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode, isIdentifier } from "./utils.ts";

const HISTORY_OWNERS = new Set(["window", "globalThis", "self"]);

/** `history`, or `history` read off a global object. */
const isHistory = (node: unknown): boolean => {
  if (isIdentifier(node, "history")) {
    return true;
  }
  return (
    isAstNode(node) &&
    node.type === "MemberExpression" &&
    getPropertyName(node.property) === "history" &&
    isIdentifier(node.object) &&
    HISTORY_OWNERS.has(node.object.name)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-e2e-router-push" },
  rules: {
    "no-raw-e2e-router-push": {
      meta: {
        type: "problem",
        messages: {
          useHelper:
            "Navigate through apps/web/e2e/helpers/decision-reader.ts: openMemberDecision or openVisitorDecision for a decision, pushRouterPath for any other route.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const { callee } = node;
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              getPropertyName(callee.property) === "pushState" &&
              isHistory(callee.object)
            ) {
              context.report({ node, messageId: "useHelper" });
            }
          },
        };
      },
    },
  },
});
