import { eslintCompatPlugin } from "@oxlint/plugins";

import { jsxName } from "./utils.ts";

const HEAVY_HOSTS = new Set([
  "DocxEditorSlot",
  "EmailFileViewer",
  "EmailViewerWithAI",
  "FileTabViewer",
  "OfficeFileViewer",
  "PeekPdfViewer",
]);

export default eslintCompatPlugin({
  meta: { name: "no-inline-heavy-host-props" },
  rules: {
    "no-inline-heavy-host-props": {
      meta: {
        type: "problem",
        messages: {
          inline:
            "Pass a referentially stable value to {{host}}. Hoist or memoize the {{kind}} prop value.",
        },
      },
      createOnce(context) {
        return {
          JSXOpeningElement(node) {
            const host = jsxName(node.name);
            if (host === null || !HEAVY_HOSTS.has(host)) {
              return;
            }
            for (const attribute of node.attributes) {
              if (
                attribute.type !== "JSXAttribute" ||
                attribute.value?.type !== "JSXExpressionContainer"
              ) {
                continue;
              }
              const expression = attribute.value.expression;
              const kind =
                expression.type === "ObjectExpression"
                  ? "object"
                  : expression.type === "ArrayExpression"
                    ? "array"
                    : expression.type === "JSXElement" ||
                        expression.type === "JSXFragment"
                      ? "JSX"
                      : null;
              if (kind !== null) {
                context.report({
                  node: expression,
                  messageId: "inline",
                  data: { host, kind },
                });
              }
            }
          },
        };
      },
    },
  },
});
