// An exhaustiveness check must fail loudly, not hand back the value it failed
// to handle.
//
// Both spellings below type-check, and both RETURN the unhandled value at
// runtime. The branch is only unreachable while the union is what it was when
// the code was written: a widened enum, an older client's payload, or a new
// database row reaches it, and the value flows on as if it had been handled.
// AGENTS.md requires a miss to panic.
//
// Flagged:
//   const exhaustive: never = kind;   // binds the unhandled value
//   return exhaustive;                //  ... and returns it
//
//   return kind satisfies never;      // returns it directly
//
//   kind satisfies never;             // asserts, then returns the same
//   return kind;                      //  ... binding anyway
//
//   kind satisfies never;             // asserts, then swallows the miss
//   return null;                      //  ... behind a typed fallback
//
// Allowed:
//   kind satisfies never;             // asserts, evaluates to nothing
//   return panic(`Unhandled kind: ${String(kind)}`);
//
// A renderer is no exception: `return null` after the assertion paints an empty
// component instead of the state nobody handled, and the miss is invisible
// until something downstream reads the gap. The route error boundary is where
// an impossible state belongs.
//
// Detection boundary: syntax only. A `never` annotation written through a type
// alias, and a helper that takes the value and returns it, are out of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { isAstNode, isCallTo, isIdentifier } from "./utils.ts";

const isNeverKeyword = (node: unknown): boolean =>
  isAstNode(node) && node.type === "TSNeverKeyword";

// `const x: never = value` — the annotation, not a conditional type whose false
// branch happens to be `never`.
const hasNeverAnnotation = (id: unknown): boolean => {
  if (!isAstNode(id)) {
    return false;
  }
  const annotation = id.typeAnnotation;
  return (
    isAstNode(annotation) &&
    isNeverKeyword(Reflect.get(annotation, "typeAnnotation"))
  );
};

const isSatisfiesNever = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "TSSatisfiesExpression" &&
  isNeverKeyword(node.typeAnnotation);

// `<expression> satisfies never;` as a statement: the asserted expression, or
// null when the statement is anything else.
const assertedExpression = (statement: unknown): AstNode | null => {
  if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
    return null;
  }
  const expression = statement.expression;
  if (!isSatisfiesNever(expression) || !isAstNode(expression)) {
    return null;
  }
  const asserted = expression.expression;
  return isAstNode(asserted) ? asserted : null;
};

const returnsIdentifier = (statement: unknown, name: string): boolean =>
  isAstNode(statement) &&
  statement.type === "ReturnStatement" &&
  isIdentifier(statement.argument, name);

// The only statements that stop the miss instead of papering over it: a
// `panic(...)` call, `return panic(...)`, or a throw.
const failsLoudly = (statement: unknown): boolean => {
  if (!isAstNode(statement)) {
    return false;
  }
  if (statement.type === "ThrowStatement") {
    return true;
  }
  if (statement.type === "ExpressionStatement") {
    return isCallTo(statement.expression, "panic");
  }
  return statement.type === "ReturnStatement" && isCallTo(statement.argument, "panic");
};

export default eslintCompatPlugin({
  meta: { name: "require-exhaustive-panic" },
  rules: {
    "require-exhaustive-panic": {
      meta: {
        type: "problem",
        messages: {
          neverBinding:
            "An exhaustiveness check must not bind the unhandled value: this returns it at runtime. " +
            "Write `<value> satisfies never;` on its own line and follow it with `panic(...)`.",
          returnedSatisfies:
            "`return <value> satisfies never` returns the unhandled value at runtime. " +
            "Write `<value> satisfies never;` on its own line and follow it with `return panic(...)`.",
          assertedThenReturned:
            "`{{name}}` is asserted unreachable and then returned, so the unhandled value still reaches the caller. " +
            "Replace the return with `return panic(...)`.",
          fallbackAfterAssertion:
            "A fallback after `satisfies never` hides an impossible state: the miss is swallowed and the value flows on unhandled. " +
            "Follow the assertion with `panic(...)`, `return panic(...)`, or a throw, so the error boundary shows the state nobody handled.",
        },
      },
      createOnce(context) {
        // A `satisfies never` assertion proves nothing at runtime, so whatever
        // follows it in the same statement list decides what a miss does.
        // Returning the asserted binding hands the value back exactly as the
        // bound-and-returned form does; any other fallback, or no statement at
        // all, swallows the miss instead.
        const checkStatements = (statements: unknown) => {
          if (!Array.isArray(statements)) {
            return;
          }
          for (const [index, statement] of statements.entries()) {
            const asserted = assertedExpression(statement);
            if (asserted === null) {
              continue;
            }
            const next = statements[index + 1];
            if (isIdentifier(asserted) && returnsIdentifier(next, asserted.name)) {
              context.report({
                node: next,
                messageId: "assertedThenReturned",
                data: { name: asserted.name },
              });
              continue;
            }
            if (failsLoudly(next)) {
              continue;
            }
            context.report({
              node: next === undefined ? statement : next,
              messageId: "fallbackAfterAssertion",
            });
          }
        };

        return {
          VariableDeclarator(node) {
            if (!hasNeverAnnotation(node.id)) {
              return;
            }
            context.report({ node, messageId: "neverBinding" });
          },
          ReturnStatement(node) {
            if (!isSatisfiesNever(node.argument)) {
              return;
            }
            context.report({ node, messageId: "returnedSatisfies" });
          },
          BlockStatement(node) {
            checkStatements(node.body);
          },
          Program(node) {
            checkStatements(node.body);
          },
          SwitchCase(node) {
            checkStatements(node.consequent);
          },
          StaticBlock(node) {
            checkStatements(node.body);
          },
        };
      },
    },
  },
});
