// Ban TypeBox unions whose members are built by an array-producing call.
//
// `t.Union(values.map((value) => t.Literal(value)))` and
// `t.UnionEnum(Object.values(X))` compile and validate at runtime, but the
// argument's type is a widened array (`TLiteral<string>[]`, `string[]`), not a
// tuple. TypeBox's `Static` of a union over a non-tuple array collapses (to
// `never`, or the field reads as `null`), so the schema's type silently
// disagrees with the data the handler returns or accepts.
//
// Flagged (first argument of `Union` / `UnionEnum`):
//   t.Union(CITATION_DIRECTIONS.map((value) => t.Literal(value)))
//   t.UnionEnum(Object.values(STATUS))
//   t.UnionEnum(KINDS.filter((kind) => kind !== "draft"))
//   t.Union([...KINDS.map((kind) => t.Literal(kind))])
// Allowed:
//   t.Enum(STATUS)                                   (const object)
//   t.UnionEnum(KINDS)                               (`as const` tuple)
//   t.Union([t.Literal("a"), t.Literal("b")])        (array literal)
//   t.UnionEnum(table.kind.enumValues)               (member expression)
//   t.UnionEnum([FIRST, ...REST.map((r) => r.code)]) (variadic tuple)
//
// An identifier or member expression may name an `as const` tuple, which
// types correctly; when it names a widened array the type checker reports the
// mismatch at the consumer. A call expression (`.map`, `.filter`,
// `Object.values`, `Array.from`) always yields a widened array, so any
// non-literal, non-reference argument is reported. An array literal is a
// tuple unless every element is a spread: `[...xs.map(f)]` is still `X[]`,
// while `[first, ...xs.map(f)]` types as the variadic tuple `[X, ...X[]]`.
//
// The callee is `<ns>.Union` / `<ns>.UnionEnum` where `<ns>` resolves to
// `t` from `elysia` or `Type` (or the namespace) from `@sinclair/typebox`.
// Destructured `Union(...)` calls are outside this check.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isImportedFrom,
  NAMESPACE_IMPORT,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

const UNION_BUILDERS = new Set(["Union", "UnionEnum"]);
const TYPEBOX_NAMESPACES = new Set(["Type", NAMESPACE_IMPORT]);
const ELYSIA_NAMESPACES = new Set(["t"]);
// Calls whose result type is a plain array even when their input is a tuple.
const WIDENING_ARRAY_METHODS = new Set([
  "concat",
  "filter",
  "flat",
  "flatMap",
  "map",
  "reverse",
  "slice",
  "sort",
  "toReversed",
  "toSorted",
  "toSpliced",
]);
const WIDENING_STATIC_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  [
    ["Array", new Set(["from", "of"])],
    ["Object", new Set(["entries", "keys", "values"])],
  ],
);

// Only known widening shapes: a helper with a declared tuple return type, or a
// conditional between tuples, keeps its tuple type and is not reported.
const isWideningCall = (expression: unknown): boolean => {
  const call = unwrapExpression(expression);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed === true ||
    !isAstNode(callee.property) ||
    callee.property.type !== "Identifier" ||
    typeof callee.property.name !== "string"
  ) {
    return false;
  }
  const method = callee.property.name;
  const owner = unwrapExpression(callee.object);
  const staticMethods =
    owner?.type === "Identifier" && typeof owner.name === "string"
      ? WIDENING_STATIC_CALLS.get(owner.name)
      : undefined;
  return staticMethods === undefined
    ? WIDENING_ARRAY_METHODS.has(method)
    : staticMethods.has(method);
};

const isWideningSpread = (element: unknown): boolean =>
  isAstNode(element) &&
  element.type === "SpreadElement" &&
  isWideningCall(element.argument);

// The argument that makes the union's members a widened array, or null.
const arrayBuiltArgument = (argument: AstNode): AstNode | null => {
  if (argument.type === "ArrayExpression") {
    const elements = Array.isArray(argument.elements) ? argument.elements : [];
    const onlySpreads = elements.every(
      (element) => isAstNode(element) && element.type === "SpreadElement",
    );
    const spread = onlySpreads ? elements.find(isWideningSpread) : undefined;
    return isAstNode(spread) ? spread : null;
  }
  return isWideningCall(argument) ? argument : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-array-built-typebox-union" },
  rules: {
    "no-array-built-typebox-union": {
      meta: {
        type: "problem",
        messages: {
          arrayBuilt:
            "A TypeBox union over a computed array has a non-tuple type, so " +
            "its `Static` collapses (to `never`, or the field becomes `null`). " +
            "Use `t.Enum(record)` for a const object, `t.UnionEnum(TUPLE)` " +
            "for an `as const` tuple, or an explicit array literal " +
            '`t.Union([t.Literal("a"), t.Literal("b")])`.',
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              callee.property.type !== "Identifier" ||
              !UNION_BUILDERS.has(callee.property.name)
            ) {
              return;
            }
            const argument = unwrapExpression(node.arguments.at(0));
            if (argument === null) {
              return;
            }
            const offending = arrayBuiltArgument(argument);
            if (offending === null) {
              return;
            }
            const isTypeBuilder =
              isImportedFrom({
                context,
                node: callee.object,
                modules: ["elysia"],
                names: ELYSIA_NAMESPACES,
              }) ||
              isImportedFrom({
                context,
                node: callee.object,
                modules: ["@sinclair/typebox"],
                names: TYPEBOX_NAMESPACES,
              });
            if (!isTypeBuilder) {
              return;
            }
            context.report({ node: offending, messageId: "arrayBuilt" });
          },
        };
      },
    },
  },
});
