// Ban `try/catch` outside the boundary modules listed in oxlint.config.ts.
//
// AGENTS.md mandates better-result for typed error handling: wrap a
// failable call with `Result.tryPromise({ try, catch })` or `Result.try(...)`
// and propagate the `Result` instead of catching exceptions locally.
// `try/finally` without a `catch` clause is unaffected — it is used for
// cleanup, not for swallowing or translating errors.
//
// Flagged:
//   try {
//     return await riskyCall();
//   } catch (cause) {
//     return fallback;
//   }
//
// Allowed:
//   try {
//     return await riskyCall();
//   } finally {
//     cleanup();
//   }
//   await Result.tryPromise({
//     try: () => riskyCall(),
//     catch: (cause) => mapError(cause),
//   });

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-try-catch-outside-boundary" },
  rules: {
    "no-try-catch-outside-boundary": {
      meta: {
        type: "problem",
        messages: {
          noTryCatchOutsideBoundary:
            "Wrap the failable call with `Result.tryPromise({ try, catch })` " +
            "or `Result.try(...)` and propagate the `Result`; `try/catch` " +
            "is reserved for boundary modules listed in oxlint.config.ts.",
        },
      },
      createOnce(context) {
        return {
          TryStatement(node: unknown) {
            if (
              !isAstNode(node) ||
              node.handler === null ||
              node.handler === undefined
            ) {
              return;
            }
            context.report({ node, messageId: "noTryCatchOutsideBoundary" });
          },
        };
      },
    },
  },
});
