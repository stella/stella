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
// The tail has to be better-result's `panic`, resolved through the import that
// binds it, under whatever local name. A `panic` from anywhere else stops
// nothing that this rule can vouch for.
//
// Detection boundary: syntax only. A `never` annotation written through a type
// alias, and a helper that takes the value and returns it, are out of scope. A
// shadowing binding is read from the statement list that declares it, so a
// parameter named `panic` is out of scope too.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  getCalleeName,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const PANIC_MODULE = "better-result";
const PANIC_EXPORT = "panic";

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

// Local names that `panic` from better-result is bound to in this file, taken
// from the import that binds it so an alias counts and a same-named import from
// anywhere else does not.
const panicBindingsIn = (statements: unknown[]): string[] => {
  const names: string[] = [];
  for (const statement of statements) {
    if (!isAstNode(statement) || statement.type !== "ImportDeclaration") {
      continue;
    }
    if (
      !isStringLiteral(statement.source) ||
      statement.source.value !== PANIC_MODULE ||
      !Array.isArray(statement.specifiers)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (getImportedName(specifier) !== PANIC_EXPORT) {
        continue;
      }
      const local = getImportLocalName(specifier);
      if (local !== null) {
        names.push(local);
      }
    }
  }
  return names;
};

// A `const`/`function` declaration in this statement list that takes over one of
// the imported names. Everything nested in the list reads the local binding, so
// the tail no longer reaches better-result.
const declaresAny = (statements: unknown[], names: Set<string>): boolean =>
  statements.some((statement) => {
    if (!isAstNode(statement)) {
      return false;
    }
    if (statement.type === "FunctionDeclaration") {
      return isIdentifier(statement.id) && names.has(statement.id.name);
    }
    if (statement.type !== "VariableDeclaration") {
      return false;
    }
    const declarations = statement.declarations;
    return (
      Array.isArray(declarations) &&
      declarations.some(
        (declarator) =>
          isAstNode(declarator) &&
          isIdentifier(declarator.id) &&
          names.has(declarator.id.name),
      )
    );
  });

const calledName = (statement: unknown): string | null => {
  if (!isAstNode(statement)) {
    return null;
  }
  const call =
    statement.type === "ExpressionStatement"
      ? statement.expression
      : statement.type === "ReturnStatement"
        ? statement.argument
        : null;
  return isAstNode(call) && call.type === "CallExpression"
    ? getCalleeName(call.callee)
    : null;
};

type TailDisposition = "loud" | "foreignPanic" | "fallback";

// What the statement after the assertion does with the miss: stop it, call
// something named `panic` that this file does not import from better-result, or
// let it through.
const tailDisposition = (
  statement: unknown,
  panicNames: Set<string>,
): TailDisposition => {
  if (isAstNode(statement) && statement.type === "ThrowStatement") {
    return "loud";
  }
  const name = calledName(statement);
  if (name === null) {
    return "fallback";
  }
  if (panicNames.has(name)) {
    return "loud";
  }
  return name === PANIC_EXPORT || name.endsWith(`.${PANIC_EXPORT}`)
    ? "foreignPanic"
    : "fallback";
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
          foreignPanic:
            "This `panic` is not the one better-result exports, so what the miss does here is whatever that binding happens to do. " +
            'Call `panic` imported from "better-result" (an alias of it counts).',
        },
      },
      createOnce(context) {
        // Every local name better-result's `panic` is bound to in this file, and
        // the statement lists where a local declaration takes one of those names
        // over. A call inside such a list reads the local binding, not the
        // import.
        const panicNames = new Set<string>();
        const shadowRanges: [number, number][] = [];

        const isShadowed = (node: AstNode): boolean =>
          shadowRanges.some(
            ([start, end]) => node.range[0] >= start && node.range[1] <= end,
          );

        const noteShadow = (node: AstNode, statements: unknown) => {
          if (
            panicNames.size === 0 ||
            !Array.isArray(statements) ||
            !declaresAny(statements, panicNames)
          ) {
            return;
          }
          shadowRanges.push([node.range[0], node.range[1]]);
        };

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
            if (
              isIdentifier(asserted) &&
              returnsIdentifier(next, asserted.name)
            ) {
              context.report({
                node: next,
                messageId: "assertedThenReturned",
                data: { name: asserted.name },
              });
              continue;
            }
            const disposition = tailDisposition(next, panicNames);
            if (
              disposition === "loud" &&
              !(isAstNode(next) && isShadowed(next))
            ) {
              continue;
            }
            context.report({
              node: next === undefined ? statement : next,
              messageId:
                disposition === "fallback"
                  ? "fallbackAfterAssertion"
                  : "foreignPanic",
            });
          }
        };

        return {
          before() {
            panicNames.clear();
            shadowRanges.length = 0;
          },
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
            noteShadow(node, node.body);
            checkStatements(node.body);
          },
          // Imports bind before anything nested runs, and Program is visited
          // first, so the names are known by the time any tail is read.
          Program(node) {
            if (Array.isArray(node.body)) {
              for (const name of panicBindingsIn(node.body)) {
                panicNames.add(name);
              }
            }
            noteShadow(node, node.body);
            checkStatements(node.body);
          },
          SwitchCase(node) {
            noteShadow(node, node.consequent);
            checkStatements(node.consequent);
          },
          StaticBlock(node) {
            noteShadow(node, node.body);
            checkStatements(node.body);
          },
        };
      },
    },
  },
});
