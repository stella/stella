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
            // - TSAsExpression / TSTypeAssertion / TSSatisfiesExpression:
            //   `safeDb(...) as unknown` / `safeDb(...) satisfies …` —
            //   the type-only wrapper drops the value at runtime
            // - SequenceExpression: `safeDb(...), other()` discards the
            //   Result whether our call is the last operand (statement
            //   discards the sequence's value) or earlier (comma drops it)
            // - MemberExpression as the object: `safeDb(...).map(...)`
            //   continues the Result through a chained method
            // - CallExpression as the callee: the chained method call
            //   `safeDb(...).map(...)` still produces a Result the
            //   caller must consume
            // - Logical/conditional branches: `condition && safeDb(...)`
            //   and `condition ? safeDb(...) : other()` still discard
            //   the Result when the whole expression is a statement
            // If the outermost wrapper sits inside an ExpressionStatement,
            // the call result is discarded.
            let current = node;
            while (current.parent) {
              const parent = current.parent;
              const isTransparentWrapper =
                parent.type === "AwaitExpression" ||
                parent.type === "ChainExpression" ||
                parent.type === "ParenthesizedExpression" ||
                parent.type === "TSNonNullExpression" ||
                parent.type === "TSAsExpression" ||
                parent.type === "TSTypeAssertion" ||
                parent.type === "TSSatisfiesExpression" ||
                parent.type === "SequenceExpression" ||
                (parent.type === "UnaryExpression" &&
                  parent.operator === "void");
              // Chain methods (`safeDb(...).map(...)`): the Result flows
              // through `.map` as the object of a MemberExpression and
              // then becomes the callee of the chained CallExpression.
              // Only treat as transparent when we sit in those exact
              // positions; passing the Result as an argument elsewhere
              // counts as consumption.
              const isChainStep =
                (parent.type === "MemberExpression" &&
                  parent.object === current) ||
                (parent.type === "CallExpression" && parent.callee === current);
              const isDiscardedExpressionBranch =
                (parent.type === "LogicalExpression" &&
                  (parent.left === current || parent.right === current)) ||
                (parent.type === "ConditionalExpression" &&
                  (parent.consequent === current ||
                    parent.alternate === current));
              if (
                !isTransparentWrapper &&
                !isChainStep &&
                !isDiscardedExpressionBranch
              ) {
                break;
              }
              current = parent;
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
