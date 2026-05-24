// Disallow `as any` and `<any>` casts.
//
// Distinct from `no-explicit-any` (which targets `: any` annotations
// in declarations). This rule catches the cast form — typically
// `value as any` or the laundering `value as any as Target` — which
// bypasses brand checks, discriminated-union narrowing, and every
// other safety the type system provides.

export default {
  meta: { name: "no-any-casts" },
  rules: {
    "no-any-casts": {
      meta: {
        type: "problem",
        messages: {
          noAnyCast:
            "Avoid `as any` casts. They bypass branded IDs and " +
            "discriminated-union narrowing. Narrow with a type guard, " +
            "use `unknown` + a guard, or refactor the source so the " +
            "cast isn't needed.",
        },
      },
      create(context) {
        function check(node) {
          if (node.typeAnnotation?.type === "TSAnyKeyword") {
            context.report({ node, messageId: "noAnyCast" });
          }
        }
        return {
          TSAsExpression: check,
          TSTypeAssertion: check,
        };
      },
    },
  },
};
