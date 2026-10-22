// Domain values stay visible to TypeScript and runtime consumers as string
// literal unions or `as const` lookup tables. TypeScript enums emit runtime
// objects and create a second representation of the same domain vocabulary.

import { eslintCompatPlugin } from "@oxlint/plugins";

export default eslintCompatPlugin({
  meta: { name: "no-domain-enum" },
  rules: {
    "no-domain-enum": {
      meta: {
        type: "problem",
        messages: {
          forbidden:
            "Use a string-literal union or an `as const` lookup table instead of a TypeScript enum.",
        },
      },
      createOnce(context) {
        return {
          TSEnumDeclaration(node) {
            context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
  },
});
