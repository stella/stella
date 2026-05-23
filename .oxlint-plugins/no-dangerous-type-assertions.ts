// Disallow object-literal casts: `{...} as T`, `<T>{...}`.
//
// Casting an object literal to a type silently hides missing required
// fields — the type system would otherwise catch the omission. Use a
// typed binding (`const x: T = { ... }`) or `satisfies T` so missing
// fields surface as type errors.
//
// Allows `as const` (legitimate widening control).
// Allows `as any` / `as unknown` (those have dedicated rules / are
// often used as the first step of an explicit launder).

export default {
  meta: { name: "no-dangerous-type-assertions" },
  rules: {
    "no-dangerous-type-assertions": {
      meta: {
        type: "problem",
        messages: {
          noObjectLiteralCast:
            "Don't cast an object literal with `as`. Type the binding " +
            "(`const x: T = { ... }`) or use `satisfies T` so missing " +
            "required fields fail typecheck.",
        },
      },
      create(context) {
        function check(node) {
          if (node.expression?.type !== "ObjectExpression") {
            return;
          }
          const ann = node.typeAnnotation;
          if (!ann) {
            return;
          }
          // Allow `as const`
          if (
            ann.type === "TSTypeReference" &&
            ann.typeName?.type === "Identifier" &&
            ann.typeName.name === "const"
          ) {
            return;
          }
          // `as any` and `as unknown` have their own rules / are
          // typically the laundering step, not the final shape claim.
          if (ann.type === "TSAnyKeyword" || ann.type === "TSUnknownKeyword") {
            return;
          }
          context.report({ node, messageId: "noObjectLiteralCast" });
        }
        return {
          TSAsExpression: check,
          TSTypeAssertion: check,
        };
      },
    },
  },
};
