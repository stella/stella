// Disallow discarding the return value of Result-producing calls.
//
// better-result is the project's typed error channel; dropping a
// Result silently swallows both success and error. Calls to
// Result.gen / Result.tryPromise / Result.await / safeDb /
// createSafeHandler / createSafeRootHandler must be awaited,
// yielded, returned, assigned, or otherwise structurally consumed.
//
// Detected by checking that the CallExpression is not the direct
// expression of an ExpressionStatement — i.e. that its result lands
// somewhere downstream.

import { getCalleeName } from "./utils.ts";

const RESULT_FUNCTIONS = new Set([
  "Result.gen",
  "Result.tryPromise",
  "Result.await",
  "Result.all",
  "Result.allSettled",
  "Result.fromPromise",
  "safeDb",
  "createSafeHandler",
  "createSafeRootHandler",
]);

export default {
  meta: { name: "must-use-result" },
  rules: {
    "must-use-result": {
      meta: {
        type: "problem",
        messages: {
          mustUseResult:
            "Result-producing call to '{{name}}' is unused. " +
            "Await, yield*, assign, or return it. " +
            "Discarding a Result silently swallows errors.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const name = getCalleeName(node.callee);
            if (name === null || !RESULT_FUNCTIONS.has(name)) {
              return;
            }
            // Walk up through wrappers that don't consume the Result:
            // - AwaitExpression: `await safeDb(...)` still drops the Result
            // - ChainExpression: `safeDb(...)?.foo` produces a Chain wrapper
            // - ParenthesizedExpression: `(safeDb(...))`
            // - TSNonNullExpression: `safeDb(...)!`
            // - UnaryExpression(void): `void safeDb(...)` — the project
            //   sets `no-void: { allowAsStatement: true }`, so without
            //   this `void` becomes a one-token bypass of the rule
            // - TSAsExpression / TSTypeAssertion: `safeDb(...) as unknown`
            //   launders the Result type away but still drops the value
            // If the outermost wrapper sits inside an ExpressionStatement,
            // the call result is discarded.
            let current = node;
            while (
              current.parent &&
              (current.parent.type === "AwaitExpression" ||
                current.parent.type === "ChainExpression" ||
                current.parent.type === "ParenthesizedExpression" ||
                current.parent.type === "TSNonNullExpression" ||
                current.parent.type === "TSAsExpression" ||
                current.parent.type === "TSTypeAssertion" ||
                (current.parent.type === "UnaryExpression" &&
                  current.parent.operator === "void"))
            ) {
              current = current.parent;
            }
            if (current.parent?.type !== "ExpressionStatement") {
              return;
            }
            context.report({
              node,
              messageId: "mustUseResult",
              data: { name },
            });
          },
        };
      },
    },
  },
};
