import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, jsxName } from "./utils.ts";

const HEADING_NAMES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const HEADER_COMPONENT_NAMES = new Set(["InspectorHeader"]);
const HEADER_SLOT =
  /data-slot=["'](?:inspector-header|inspector-panel-header)["']/u;
const STRUCTURAL_BOUNDARY_NAMES = new Set(["article", "main", "section"]);

const isComponentName = (name: string): boolean => /^[A-Z]/u.test(name);

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
            let hasRootHeader = false;
            while (isAstNode(ancestor)) {
              if (ancestor.type === "JSXElement") {
                if (!isAstNode(ancestor.openingElement)) {
                  return;
                }
                const name = jsxName(ancestor.openingElement.name) ?? "";
                const isMarkedHeader =
                  HEADER_COMPONENT_NAMES.has(name) ||
                  HEADER_SLOT.test(
                    context.sourceCode.getText(ancestor.openingElement),
                  );
                if (isMarkedHeader) {
                  context.report({ node, messageId: "rawHeading" });
                  return;
                }
                if (
                  STRUCTURAL_BOUNDARY_NAMES.has(name) ||
                  isComponentName(name)
                ) {
                  return;
                }
                if (name === "header") {
                  hasRootHeader = true;
                } else if (hasRootHeader) {
                  // A semantic header nested in document content is not the
                  // inspector shell's top-level header.
                  return;
                }
              } else if (ancestor.type === "JSXFragment" && hasRootHeader) {
                return;
              }
              ancestor = ancestor.parent;
            }
            if (hasRootHeader) {
              context.report({ node, messageId: "rawHeading" });
            }
          },
        };
      },
    },
  },
});
