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
// Allowed:
//   kind satisfies never;             // asserts, evaluates to nothing
//   return panic(`Unhandled kind: ${String(kind)}`);
//
//   kind satisfies never;             // a deliberate typed fallback still
//   return null;                      //  ... returns nothing unhandled
//
// Detection boundary: syntax only. A `never` annotation written through a type
// alias, and a helper that takes the value and returns it, are out of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, isIdentifier } from "./utils.ts";

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

// `<identifier> satisfies never;` as a statement: the name it asserts on, or
// null when the statement is anything else.
const assertedIdentifier = (statement: unknown): string | null => {
  if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
    return null;
  }
  const expression = statement.expression;
  if (!isSatisfiesNever(expression) || !isAstNode(expression)) {
    return null;
  }
  const asserted = expression.expression;
  return isIdentifier(asserted) ? asserted.name : null;
};

const returnsIdentifier = (statement: unknown, name: string): boolean =>
  isAstNode(statement) &&
  statement.type === "ReturnStatement" &&
  isIdentifier(statement.argument, name);

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
            "Replace the return with `return panic(...)`; a fallback that returns something else stays valid.",
        },
      },
      createOnce(context) {
        // A `satisfies never` assertion followed by `return <same name>` in the
        // same statement list: the assertion proves nothing at runtime, so the
        // return hands the value back exactly as the bound-and-returned form
        // does. Only an adjacent, identical identifier is matched.
        const checkStatements = (statements: unknown) => {
          if (!Array.isArray(statements)) {
            return;
          }
          for (const [index, statement] of statements.entries()) {
            const name = assertedIdentifier(statement);
            if (name === null) {
              continue;
            }
            const next = statements[index + 1];
            if (!returnsIdentifier(next, name)) {
              continue;
            }
            context.report({
              node: next,
              messageId: "assertedThenReturned",
              data: { name },
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
