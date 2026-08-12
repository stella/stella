// Ban AsyncLocalStorage.enterWith().
//
// `enterWith` binds a store by mutating the ambient async context frame, and
// nothing restores it: the runtime leaves that frame current for callbacks it
// dispatches afterwards. Any long-lived background loop (a queue worker, a
// reconciler timer, an SSE keep-alive) that resumes while a request's frame is
// current therefore joins that request's store and keeps it, so its work is
// billed to a request that has nothing to do with it — a misattribution that
// surfaces as a rare, unreproducible count or id rather than a failure.
//
// `run(store, fn)` restores the previous frame when `fn` returns, so the store
// covers exactly the callback tree it was opened for. When the lifecycle is
// split across callbacks with no single function to wrap (framework hooks),
// scope it at the boundary and have the hooks fill in a mutable store; see
// `apps/api/src/lib/observability/request-scope.ts`.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isIdentifier } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-async-context-enter-with" },
  rules: {
    "no-async-context-enter-with": {
      meta: {
        type: "problem",
        messages: {
          noEnterWith:
            "Do not use AsyncLocalStorage.enterWith(): it mutates the ambient " +
            "async context frame with no restore point, so background work " +
            "that resumes there adopts the store. Scope it with run(...) at " +
            "the boundary instead (see request-scope.ts).",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              !isIdentifier(callee.property, "enterWith")
            ) {
              return;
            }

            context.report({ node, messageId: "noEnterWith" });
          },
        };
      },
    },
  },
});
