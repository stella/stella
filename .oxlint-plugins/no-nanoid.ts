// Ban nanoid imports.
//
// The project uses native Bun.randomUUIDv7() for ID generation
// and crypto.getRandomValues() for custom alphabets. nanoid is
// a removed dependency; this rule prevents re-introduction.

export default {
  meta: { name: "no-nanoid" },
  rules: {
    "no-nanoid": {
      meta: {
        type: "problem",
        messages: {
          noNanoid:
            "Do not import nanoid. Use Bun.randomUUIDv7() " +
            "for IDs or crypto.getRandomValues() for custom " +
            "alphabets.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (node.source.value === "nanoid") {
              context.report({
                node,
                messageId: "noNanoid",
              });
            }
          },
        };
      },
    },
  },
};
