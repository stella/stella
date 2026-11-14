/**
 * Browser specs answer intercepted requests through
 * `apps/web/e2e/helpers/route-mock.ts`, never through a raw `fulfill`. A raw
 * call takes any JSON, so a mocked body is a hand-written copy of the API
 * contract that nothing checks: when the contract grows a field, the copy
 * still compiles and the app fails only in the browser run. The owner's
 * builders type each JSON body by the route it answers (or parse it with the
 * shared schema), and its non-JSON builders refuse a JSON content type.
 *
 * Syntax only: a call of a method named `fulfill` on any receiver, including
 * the optional and computed forms. A `fulfill` reached through an alias of the
 * method is not seen.
 */
import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-raw-e2e-route-fulfill" },
  rules: {
    "no-raw-e2e-route-fulfill": {
      meta: {
        type: "problem",
        messages: {
          useOwner:
            "Answer intercepted requests with respond() from apps/web/e2e/helpers/route-mock.ts: apiJson for an API route (typed by its response), contractJson or authJson for an auth endpoint, apiError for a failure, staticBody, eventStream or emptyReply for anything that is not JSON.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const { callee } = node;
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              getPropertyName(callee.property) === "fulfill"
            ) {
              context.report({ node, messageId: "useOwner" });
            }
          },
        };
      },
    },
  },
});
