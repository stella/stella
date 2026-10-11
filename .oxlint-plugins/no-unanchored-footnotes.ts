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
            "Read typed body/note lines through createParagraphLineReader; source parsers must preserve note membership and paragraph anchors.",
        },
      },
      createOnce(context) {
        return {
          ImportSpecifier(node) {
            if (
              getPropertyName(node.imported) === "createParagraphFootnoteReader"
            ) {
              context.report({ node, messageId: "unanchored" });
            }
          },
          MemberExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            if (
              ["footnotes", "createParagraphFootnoteReader"].includes(
                memberPropertyName(node) ?? "",
              )
            ) {
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
