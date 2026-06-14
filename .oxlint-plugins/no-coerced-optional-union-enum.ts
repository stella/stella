// Ban `t.Optional(t.UnionEnum([...]))` in Elysia schemas.
//
// Elysia coerces an ABSENT optional UnionEnum field to its FIRST
// member instead of leaving it `undefined` (verified in
// apps/api/src/lib/elysia-optional-union-coercion.test.ts). A handler
// that reads the field as "no value / no filter / use a default" when
// absent therefore silently gets the first member instead — a quiet,
// type-clean bug (e.g. a list filter collapses to one value, or a
// `?? default` becomes dead code).
//
// `t.Optional(t.Union([t.Literal(...)]))` does NOT coerce (absent ->
// `undefined`), so use that and apply any default explicitly in the
// handler.
//
// Flagged:
//   type: t.Optional(t.UnionEnum(["person", "organization"]))
//   region: t.Optional(t.UnionEnum(REGIONS))
// Allowed:
//   type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")]))
//   fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")]))
//
// Both callees are matched by leaf name, so the namespaced
// `t.Optional(t.UnionEnum(...))` and a destructured `Optional(UnionEnum(...))`
// (`const { Optional, UnionEnum } = t`) are caught the same way.

// Resolve a callee's leaf name whether it is namespaced (`t.Optional`,
// a MemberExpression) or a bare/destructured `Optional` (an Identifier).
const memberName = (node) => {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (
    node.type === "MemberExpression" &&
    node.property &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
};

export default {
  meta: { name: "no-coerced-optional-union-enum" },
  rules: {
    "no-coerced-optional-union-enum": {
      meta: {
        type: "problem",
        messages: {
          coerced:
            "`t.Optional(t.UnionEnum(...))` coerces an absent field to its " +
            "FIRST member, not `undefined`. Use " +
            "`t.Optional(t.Union([t.Literal(...)]))` and default explicitly " +
            "in the handler.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (memberName(node.callee) !== "Optional") {
              return;
            }
            const arg = node.arguments && node.arguments[0];
            if (
              arg &&
              arg.type === "CallExpression" &&
              memberName(arg.callee) === "UnionEnum"
            ) {
              context.report({ node, messageId: "coerced" });
            }
          },
        };
      },
    },
  },
};
