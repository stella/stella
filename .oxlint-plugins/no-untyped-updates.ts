// Disallow Record<string, unknown> variable assignments in handlers.
//
// Handlers that build partial update objects should use
// pickDefined() from lib/pick-defined.ts instead of manually
// constructing Record<string, unknown> = { ... }. The helper
// returns Partial<Pick<T, K>>, catching typos at compile time
// and preventing extra body fields from leaking into Drizzle's
// .set() clause.
//
// Replaces: scripts/lint-untyped-updates.sh

export default {
  meta: { name: "no-untyped-updates" },
  rules: {
    "no-untyped-updates": {
      meta: {
        type: "problem",
        messages: {
          untypedUpdate:
            "Don't use 'Record<string, unknown>' for " +
            "update objects. Use pickDefined() from " +
            "lib/pick-defined.ts instead.",
        },
      },
      create(context) {
        return {
          VariableDeclarator(node) {
            // Match: const/let foo: Record<string, unknown> =
            // The type annotation is on the id node
            const typeAnnotation =
              node.id.typeAnnotation?.typeAnnotation;
            if (!typeAnnotation) return;
            if (!node.init) return;

            if (
              typeAnnotation.type === "TSTypeReference" &&
              typeAnnotation.typeName?.type === "Identifier" &&
              typeAnnotation.typeName.name === "Record"
            ) {
              const params = typeAnnotation.typeArguments?.params;
              if (!params || params.length !== 2) return;

              const [keyType, valueType] = params;

              // Record<string, unknown> or Record<string, any>
              if (
                keyType.type === "TSStringKeyword" &&
                (valueType.type === "TSUnknownKeyword" ||
                  valueType.type === "TSAnyKeyword")
              ) {
                context.report({
                  node,
                  messageId: "untypedUpdate",
                });
              }
            }
          },
        };
      },
    },
  },
};
