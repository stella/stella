import { eslintCompatPlugin } from "@oxlint/plugins";

// Node loads runtime JSON modules only when their static import declares its type.
// Erased type imports and dynamic imports have separate loading semantics.
export default eslintCompatPlugin({
  meta: { name: "require-json-import-attribute" },
  rules: {
    "require-json-import-attribute": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          missingType:
            "Static JSON imports in Node/Bun-run code require with { type: 'json' }.",
        },
      },
      createOnce(context) {
        return {
          ImportDeclaration(node) {
            if (node.importKind === "type") {
              return;
            }
            if (
              typeof node.source.value !== "string" ||
              !(/^data:/iu.test(node.source.value)
                ? /^data:application\/json(?:;[^,]*)?,/iu.test(
                    node.source.value,
                  )
                : /^[^?#]*\.json(?:[?#]|$)/u.test(node.source.value))
            ) {
              return;
            }
            if (
              node.attributes.some(
                (attribute) =>
                  (attribute.key.type === "Identifier"
                    ? attribute.key.name
                    : attribute.key.value) === "type" &&
                  attribute.value.value === "json",
              )
            ) {
              return;
            }
            context.report({ node, messageId: "missingType" });
          },
        };
      },
    },
  },
});
