// Require `escapeLike()` on values interpolated into SQL LIKE / ILIKE patterns.
//
// Drizzle's `like` / `ilike` / `notLike` / `notIlike` and a `sql` template
// parameterize the pattern value, but they do NOT escape the LIKE
// metacharacters `%` and `_` inside it: in a LIKE pattern those are wildcards
// by design, so escaping user input is the caller's job. An un-escaped value
// lets a typed `%` match every row and `_` match any character: a correctness
// bug and a full-table scan. The shared helper is `escapeLike()` from
// `@/api/lib/escape-like`; Postgres's default LIKE escape character is the
// backslash the helper emits, so no `ESCAPE` clause is needed.
//
// Operators and the `sql` tag are recognised by import from drizzle-orm under
// any local name (aliased, namespace member, destructured, `(0, f)(...)`), and
// the escape helper only counts when it resolves to its owning module.
//
// Flags a LIKE pattern whose dynamic part is not escaped:
//   ilike(col, `%${q}%`)
//   ilike(col, "%" + q + "%")
//   const p = `%${q}%`;        like(col, p)
//   sql`${col} ILIKE ${`%${q}%`}`
//   sql`${col} LIKE '%' || ${q} || '%'`
//
// Allows:
//   ilike(col, `%${escapeLike(q)}%`)
//   sql`${col} LIKE ${fold(escapeLike(q))} || '%'`
//   ilike(col, pattern)        // opaque variable: cannot inspect
//   like(col, "literal")       // constant, no interpolation
//
// Escape hatch:
//   // oxlint-disable-next-line require-escape-like/require-escape-like -- <why>
//   when the interpolation is provably wildcard-free.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  type ImportedFromOptions,
  invokedCallee,
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  isStringLiteral,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const LIKE_OPERATORS: ReadonlySet<string> = new Set([
  "like",
  "ilike",
  "notLike",
  "notIlike",
]);
const SQL_TAG: ReadonlySet<string> = new Set(["sql"]);
const ESCAPE_LIKE: ReadonlySet<string> = new Set(["escapeLike"]);
const ESCAPE_LIKE_MODULE = "apps/api/src/lib/escape-like";

const isDrizzleModule = (moduleId: string): boolean =>
  moduleId === "drizzle-orm" || moduleId.startsWith("drizzle-orm/");

// Static SQL text ending in `LIKE` / `NOT ILIKE`: the next interpolation is
// the whole pattern.
const LIKE_OPERAND_TAIL = /\b(?:NOT\s+)?I?LIKE\s*$/iu;
// Static SQL text ending in `LIKE '<literal>' ||`: the next interpolation is
// concatenated into the pattern verbatim.
const LIKE_CONCAT_TAIL =
  /\b(?:NOT\s+)?I?LIKE\s+(?:'(?:[^']|'')*'\s*\|\|\s*)+$/iu;
const CONCAT_HEAD = /^\s*\|\|/u;

// Guards the identifier-to-initializer walk against self-referential consts.
const MAX_RESOLVE_DEPTH = 4;

// The initializer a single-assignment `const` identifier holds.
const constInitializer = (
  context: RuleContext,
  node: AstNode,
): AstNode | null => {
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  return variable === null ? null : stableInitializer(variable);
};

// Whether an expression is, or wraps, an `escapeLike(...)` call from its
// owning module: `escapeLike(q)`, `fold(escapeLike(q))`,
// `escapeLike(q).toLowerCase()`, or a const holding one of those.
const isEscaped = (context: RuleContext, node: unknown, depth = 0): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_RESOLVE_DEPTH) {
    return false;
  }
  if (expression.type === "CallExpression") {
    if (
      isImportedFrom({
        context,
        node: invokedCallee(expression),
        modules: [ESCAPE_LIKE_MODULE],
        names: ESCAPE_LIKE,
      })
    ) {
      return true;
    }
    const callee = unwrapExpression(expression.callee);
    if (
      callee?.type === "MemberExpression" &&
      isEscaped(context, callee.object, depth + 1)
    ) {
      return true;
    }
    return (
      Array.isArray(expression.arguments) &&
      expression.arguments.some((argument) =>
        isEscaped(context, argument, depth + 1),
      )
    );
  }
  const init = constInitializer(context, expression);
  return init !== null && isEscaped(context, init, depth + 1);
};

// The leaves of a `a + b + c` string concatenation.
const concatenationLeaves = (node: AstNode): unknown[] => {
  if (node.type !== "BinaryExpression" || node.operator !== "+") {
    return [node];
  }
  const left = unwrapExpression(node.left);
  const right = unwrapExpression(node.right);
  return [
    ...(left === null ? [] : concatenationLeaves(left)),
    ...(right === null ? [] : concatenationLeaves(right)),
  ];
};

const isStaticString = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    isStringLiteral(expression) ||
    (expression?.type === "TemplateLiteral" &&
      Array.isArray(expression.expressions) &&
      expression.expressions.length === 0)
  );
};

// Whether a JS-built LIKE pattern carries a dynamic part that is not escaped.
// Opaque values (a parameter, a call result) cannot be inspected and pass.
const hasUnescapedPart = (
  context: RuleContext,
  node: unknown,
  depth = 0,
): boolean => {
  const pattern = unwrapExpression(node);
  if (pattern === null || depth > MAX_RESOLVE_DEPTH) {
    return false;
  }
  if (pattern.type === "TemplateLiteral") {
    return (
      Array.isArray(pattern.expressions) &&
      pattern.expressions.some((part) => !isEscaped(context, part))
    );
  }
  if (pattern.type === "BinaryExpression" && pattern.operator === "+") {
    const leaves = concatenationLeaves(pattern);
    return (
      leaves.some(isStaticString) &&
      leaves.some((leaf) => !isStaticString(leaf) && !isEscaped(context, leaf))
    );
  }
  const init = constInitializer(context, pattern);
  return init !== null && hasUnescapedPart(context, init, depth + 1);
};

const quasiText = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : null;
  return typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
    ? value.raw
    : "";
};

export default eslintCompatPlugin({
  meta: { name: "require-escape-like" },
  rules: {
    "require-escape-like": {
      meta: {
        type: "problem",
        messages: {
          unescaped:
            "Wrap interpolated values in this LIKE/ILIKE pattern with " +
            "`escapeLike()` (from @/api/lib/escape-like) so a typed `%` or `_` " +
            "matches literally instead of acting as a wildcard.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const call = unwrapExpression(node);
            if (
              call === null ||
              !isImportedFrom({
                context,
                node: invokedCallee(call),
                modules: [isDrizzleModule],
                names: LIKE_OPERATORS,
              })
            ) {
              return;
            }
            const callee = unwrapExpression(call.callee);
            const args = Array.isArray(call.arguments) ? call.arguments : [];
            // `f.call(thisArg, column, pattern)` shifts the operands by one.
            const offset =
              callee?.type === "MemberExpression" &&
              invokedCallee(call) !== callee
                ? 1
                : 0;
            if (hasUnescapedPart(context, args.at(1 + offset))) {
              context.report({ node, messageId: "unescaped" });
            }
          },
          TaggedTemplateExpression(node) {
            if (
              !isImportedFrom({
                context,
                node: node.tag,
                modules: [isDrizzleModule],
                names: SQL_TAG,
              })
            ) {
              return;
            }
            const quasi = node.quasi;
            const quasis = Array.isArray(quasi.quasis) ? quasi.quasis : [];
            const expressions = Array.isArray(quasi.expressions)
              ? quasi.expressions
              : [];
            for (const [index, expression] of expressions.entries()) {
              const before = quasiText(quasis.at(index));
              const after = quasiText(quasis.at(index + 1));
              const concatenated =
                LIKE_CONCAT_TAIL.test(before) ||
                (LIKE_OPERAND_TAIL.test(before) && CONCAT_HEAD.test(after));
              const unescaped = concatenated
                ? !isEscaped(context, expression)
                : LIKE_OPERAND_TAIL.test(before) &&
                  hasUnescapedPart(context, expression);
              if (unescaped) {
                context.report({ node: expression, messageId: "unescaped" });
              }
            }
          },
        };
      },
    },
  },
});
