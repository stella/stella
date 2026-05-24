// Ban bare `throw new Error(...)` in production code.
//
// Use `panic()` from better-result for invariants and programmer
// errors, or a `TaggedError` subclass for runtime failures that
// callers should distinguish. Bare `throw new Error(...)` bypasses
// structured error handling and produces unindexable string-only
// telemetry.
//
// Flagged:
//   throw new Error("Something went wrong");
//   throw new Error(`HTTP ${response.status}`);
//   throw Error("no new keyword");
//
// Allowed:
//   throw new FetchBoundaryError({ url, status, message });
//   panic("invariant violated");
//   throw err;  // re-throw

export default {
  meta: { name: "no-bare-error" },
  rules: {
    "no-bare-error": {
      meta: {
        type: "problem",
        messages: {
          noBareError:
            "Use panic() from better-result for invariants or a " +
            "TaggedError subclass for runtime failures. Bare " +
            "`throw new Error(...)` bypasses structured error handling.",
        },
      },
      create(context) {
        return {
          ThrowStatement(node) {
            const argument = node.argument;
            // `Error(...)` without `new` produces the same object;
            // both forms must be flagged.
            if (
              !argument ||
              (argument.type !== "NewExpression" &&
                argument.type !== "CallExpression")
            ) {
              return;
            }

            const callee = argument.callee;
            if (callee.type !== "Identifier" || callee.name !== "Error") {
              return;
            }

            context.report({
              node: argument,
              messageId: "noBareError",
            });
          },
        };
      },
    },
  },
};
