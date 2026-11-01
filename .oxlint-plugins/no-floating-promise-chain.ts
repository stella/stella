// Forbid a promise chain started as a bare statement in API source.
//
// `work().catch(report);` passes every floating-promise check, but the work
// it starts runs inside the caller's async context: its SQL statements land
// in the caller's query counter (the request's `x-db-queries`, the task's or
// job's statement ceiling) whenever they happen to run before that
// measurement ends. Detached work finishes at a time the caller does not
// control, so the measurement stops being reproducible. The API's
// `detached(() => work, "feature.action")` helper
// (`@/api/lib/analytics/capture`) starts the work outside every counter and
// routes its rejection to error capture; work that needs its own failure
// handling keeps it inside the function.
//
// Flags (as statements):
//   flushSearchRepairs(ids).catch(report);
//   work().then(onDone);
//   started.finally(release);
//   client?.close().catch(report);
//
// Accepts:
//   await work().catch(report);
//   return work().then(onDone);
//   const pending = work().finally(release);
//   detached(() => flushSearchRepairs(ids), "contacts.flush-search-repairs");
//
// Detection is syntactic: a statement whose value is a `.catch`, `.then` or
// `.finally` call. Assigning the chain to a binding or returning it hands
// ownership to code that can await it, which is outside this rule.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, memberPropertyName } from "./utils.ts";

const CHAIN_METHODS = new Set(["catch", "then", "finally"]);

const chainMethod = (expression: unknown): string | null => {
  if (!isAstNode(expression)) {
    return null;
  }
  if (
    expression.type === "ChainExpression" ||
    expression.type === "ParenthesizedExpression"
  ) {
    return chainMethod(expression.expression);
  }
  if (
    expression.type !== "CallExpression" ||
    !isAstNode(expression.callee) ||
    expression.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const method = memberPropertyName(expression.callee);
  return method !== null && CHAIN_METHODS.has(method) ? method : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-floating-promise-chain" },
  rules: {
    "no-floating-promise-chain": {
      meta: {
        type: "problem",
        messages: {
          floatingChain:
            "Do not start un-awaited work as a bare `.{{method}}(...)` " +
            "statement: it runs inside the caller's query counter, which " +
            "makes that measurement depend on timing. Use " +
            '`detached(() => work, "feature.action")` from ' +
            "`@/api/lib/analytics/capture` (keep any custom failure handling " +
            "inside the function), or await the work.",
        },
      },
      createOnce(context) {
        return {
          ExpressionStatement(node) {
            const method = chainMethod(node.expression);
            if (method === null) {
              return;
            }
            context.report({
              node,
              messageId: "floatingChain",
              data: { method },
            });
          },
        };
      },
    },
  },
});
