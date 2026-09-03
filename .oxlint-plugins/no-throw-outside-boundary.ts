// Ban `throw` outside the boundary modules listed in oxlint.config.ts.
//
// AGENTS.md mandates better-result for typed error handling: production
// code returns `Result.err(...)` instead of throwing, reserving `panic()`
// for impossible internal invariants. This rule flags every
// `ThrowStatement` except a re-throw of the enclosing `catch` binding and a
// defensive `throw panic(...)` wrapper (`panic()` already never returns and
// is normally called as a statement, not thrown).
//
// Flagged:
//   throw new SomeTaggedError("message");
//   throw toAPIError(cause);
//   throw redirect("/login");
//   try {
//     ...
//   } catch (cause) {
//     throw new WrapError(cause); // wraps, so it is not a re-throw
//   }
//
// Allowed:
//   try {
//     ...
//   } catch (err) {
//     throw err; // re-throw of the catch binding
//   }
//   panic("invariant violated");
//   return panic("unreachable");
//   throw panic("defensive throw wrapper");

import { eslintCompatPlugin, type ESTree, type Scope } from "@oxlint/plugins";

import { isAstNode, isIdentifier } from "./utils.ts";

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference => isIdentifier(node);

const isPanicCall = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, "panic");

export default eslintCompatPlugin({
  meta: { name: "no-throw-outside-boundary" },
  rules: {
    "no-throw-outside-boundary": {
      meta: {
        type: "problem",
        messages: {
          noThrowOutsideBoundary:
            "Return `Result.err(new SomeTaggedError(...))` (better-result) " +
            "instead of throwing; `panic()` for impossible states; " +
            "re-throw only inside `catch`. Throwing is reserved for " +
            "boundary modules listed in oxlint.config.ts.",
        },
      },
      createOnce(context) {
        const isRethrowOfCatchBinding = (argument: unknown): boolean => {
          if (!isIdentifierReference(argument)) {
            return false;
          }

          let scope: Scope | null = context.sourceCode.getScope(argument);
          while (scope !== null) {
            const variable = scope.set.get(argument.name);
            if (variable !== undefined) {
              if (
                variable.defs.length !== 1 ||
                variable.defs.at(0)?.type !== "CatchClause"
              ) {
                return false;
              }

              let current: Scope | null = context.sourceCode.getScope(argument);
              while (current !== null && current !== variable.scope) {
                // A captured catch value thrown by a callback is a new async
                // failure, not the synchronous re-throw this exception allows.
                if (current.type === "function" || current.type === "catch") {
                  return false;
                }
                current = current.upper;
              }
              return current === variable.scope;
            }
            scope = scope.upper;
          }
          return false;
        };

        return {
          ThrowStatement(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const argument = node.argument;
            if (isPanicCall(argument) || isRethrowOfCatchBinding(argument)) {
              return;
            }
            context.report({ node, messageId: "noThrowOutsideBoundary" });
          },
        };
      },
    },
  },
});
