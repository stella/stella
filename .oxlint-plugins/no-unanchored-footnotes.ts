// Source parsers resolve the document's note collection through paragraph
// references. Direct reads can put every note at the document tail. Matches
// static property access (including aliases) and destructuring; dynamic keys
// and opaque reflection are outside this syntax guard.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  memberPropertyName,
  staticStringValue,
} from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-unanchored-footnotes" },
  rules: {
    "no-unanchored-footnotes": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          unanchored:
            "Resolve document notes through createParagraphFootnoteReader and emit each note after its referenced paragraph; do not read the package collection in source parsers.",
        },
      },
      createOnce(context) {
        return {
          MemberExpression(node) {
            if (memberPropertyName(node) === "footnotes") {
              context.report({ node, messageId: "unanchored" });
            }
          },
          ObjectPattern(node) {
            for (const property of node.properties) {
              if (
                isAstNode(property) &&
                property.type === "Property" &&
                (property.computed
                  ? staticStringValue(property.key)
                  : getPropertyName(property.key)) === "footnotes"
              ) {
                context.report({ node: property, messageId: "unanchored" });
              }
            }
          },
        };
      },
    },
  },
});
