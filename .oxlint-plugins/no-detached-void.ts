// Forbid the `void` operator.
//
// A bare `void promise` detaches a promise so `no-floating-promises` stops
// complaining, but it also throws the rejection away: an async failure
// becomes an unhandled-rejection event instead of structured telemetry.
// Route fire-and-forget work through the `detached(promise, context)` helper
// (`@/lib/detached` on the web, `@/api/lib/detached` on the API) so every
// rejection reaches the shared error-capture channel with a stable context
// tag.
//
// This bans the value-level `void` UNARY operator only; the `void` TYPE
// keyword (`: void`, `Promise<void>`, `() => void`) is a different AST node
// and is untouched.
//
// Flags:
//   void somePromise();                 // -> detached(somePromise(), "ctx")
//   void (async () => { ... })();       // -> detached((async () => {...})(), "ctx")
//   onClick={() => void save()}         // -> onClick={() => detached(save(), "ctx")}
//
// For the rare non-promise `void` (forcing reflow, marking a value used,
// exhaustiveness), restructure instead of detaching: drop the operator on a
// synchronous call statement, use `x satisfies never` for an exhaustive
// switch default, or `() => undefined` for a deliberate no-op.

export default {
  meta: { name: "no-detached-void" },
  rules: {
    "no-detached-void": {
      meta: {
        type: "problem",
        messages: {
          noVoidOperator:
            "Do not use the `void` operator. For fire-and-forget promises " +
            "use `detached(promise, context)` so the rejection is captured; " +
            "for a synchronous expression, restructure to avoid `void` " +
            "(drop it on a call statement, use `x satisfies never` for an " +
            "exhaustive default, or `() => undefined` for a no-op).",
        },
      },
      create(context) {
        return {
          UnaryExpression(node) {
            if (node.operator !== "void") {
              return;
            }
            context.report({
              node,
              messageId: "noVoidOperator",
            });
          },
        };
      },
    },
  },
};
