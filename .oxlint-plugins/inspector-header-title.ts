import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, jsxName } from "./utils.ts";

const HEADING_NAMES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const HEADER_MARKER =
  /(?:data-slot=["']inspector-panel-header["']|\bborder-b\b)/u;

export default eslintCompatPlugin({
  meta: { name: "inspector-header-title" },
  rules: {
    "inspector-header-title": {
      meta: {
        type: "problem",
        messages: {
          rawHeading:
            "Do not render a raw heading in an inspector or side-panel header. Use InspectorTabHeader, which owns single-line TruncatedText rendering, its tooltip, and its accessible name.",
        },
      },
      createOnce(context) {
        return {
          JSXOpeningElement(node) {
            if (!HEADING_NAMES.has(jsxName(node.name) ?? "")) {
              return;
            }
            let ancestor = node.parent.parent;
            while (isAstNode(ancestor)) {
              if (
                ancestor.type === "JSXElement" &&
                isAstNode(ancestor.openingElement) &&
                HEADER_MARKER.test(
                  context.sourceCode.getText(ancestor.openingElement),
                )
              ) {
                context.report({ node, messageId: "rawHeading" });
                return;
              }
              ancestor = ancestor.parent;
            }
          },
        };
      },
    },
  },
});
