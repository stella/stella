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

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, isIdentifier } from "./utils.ts";

const isPanicCall = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, "panic");

// Walk up from the throw argument to the nearest enclosing `CatchClause`
// and check whether that clause's binding is the identifier being thrown.
// This covers a plain re-throw (`catch (err) { throw err; }`); anything
// else, including a throw of a newly constructed error inside the same
// catch block, is a wrap rather than a re-throw and stays flagged.
const isRethrowOfCatchBinding = (argument: unknown): boolean => {
  if (!isIdentifier(argument)) {
    return false;
  }
  let current = argument.parent;
  while (isAstNode(current)) {
    if (current.type === "CatchClause") {
      return isIdentifier(current.param, argument.name);
    }
    current = current.parent;
  }
  return false;
};

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
