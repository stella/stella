// The better-result boundary: ban `throw` and `try/catch` outside the boundary
// modules listed in scripts/result-boundary-globs.ts.
//
// AGENTS.md mandates better-result for typed error handling: production code
// returns `Result.err(...)` instead of throwing, reserves `panic()` for
// impossible internal invariants, and wraps a failable call with
// `Result.tryPromise({ try, catch })` or `Result.try(...)` instead of catching
// locally. Both rules share one scope in oxlint.config.ts (the enrolled
// directories minus the boundary carve-out), so they live in one plugin.
//
// `no-throw-outside-boundary` flags every `ThrowStatement` except a re-throw of
// the enclosing `catch` binding and a defensive `throw panic(...)` wrapper
// (`panic()` already never returns and is normally called as a statement).
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
//
// `no-try-catch-outside-boundary` flags a `try` statement with a `catch`
// clause. `try/finally` without `catch` is unaffected: it is used for cleanup,
// not for swallowing or translating errors.
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

import { eslintCompatPlugin, type Scope } from "@oxlint/plugins";

import type { ImportedFromOptions, ScopeContext } from "./utils.ts";
import {
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  resolveVariable,
} from "./utils.ts";

const PANIC_NAMES: ReadonlySet<string> = new Set(["panic"]);

// `panic(...)` imported from better-result, under any local name.
const isPanicCall = (
  context: ImportedFromOptions["context"],
  node: unknown,
): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isImportedFrom({
    context,
    node: node.callee,
    modules: ["better-result"],
    names: PANIC_NAMES,
  });

// A synchronous re-throw of the binding declared by the enclosing `catch`
// clause. A captured catch value thrown by a callback is a new async failure,
// and a shadowing local is a different value, so neither counts.
const isRethrowOfCatchBinding = (
  context: ScopeContext,
  argument: unknown,
): boolean => {
  if (!isIdentifierReference(argument)) {
    return false;
  }
  const variable = resolveVariable(context, argument);
  if (
    variable === null ||
    variable.defs.length !== 1 ||
    variable.defs.at(0)?.type !== "CatchClause"
  ) {
    return false;
  }
  let current: Scope | null = context.sourceCode.getScope(argument);
  while (current !== null && current !== variable.scope) {
    if (current.type === "function" || current.type === "catch") {
      return false;
    }
    current = current.upper;
  }
  return current === variable.scope;
};

export default eslintCompatPlugin({
  meta: { name: "result-boundary" },
  rules: {
    "no-throw-outside-boundary": {
      meta: {
        type: "problem",
        messages: {
          noThrowOutsideBoundary:
            "Return `Result.err(new SomeTaggedError(...))` (better-result) " +
            "instead of throwing; `panic()` for impossible states; " +
            "re-throw only inside `catch`. Throwing is reserved for " +
            "boundary modules listed in scripts/result-boundary-globs.ts.",
        },
      },
      createOnce(context) {
        return {
          ThrowStatement(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const argument = node.argument;
            if (
              isPanicCall(context, argument) ||
              isRethrowOfCatchBinding(context, argument)
            ) {
              return;
            }
            context.report({ node, messageId: "noThrowOutsideBoundary" });
          },
        };
      },
    },
    "no-try-catch-outside-boundary": {
      meta: {
        type: "problem",
        messages: {
          noTryCatchOutsideBoundary:
            "Wrap the failable call with `Result.tryPromise({ try, catch })` " +
            "or `Result.try(...)` and propagate the `Result`; `try/catch` " +
            "is reserved for boundary modules listed in " +
            "scripts/result-boundary-globs.ts.",
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
