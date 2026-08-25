import { eslintCompatPlugin } from "@oxlint/plugins";
// Detect physical directional Tailwind CSS properties that should
// use logical equivalents for RTL support.
//
// Physical properties (ml-, mr-, pl-, pr-, left-*, right-*,
// text-left, text-right, border-l, border-r, rounded-l, rounded-r)
// are fixed to LTR layout. Logical properties (ms-, me-, ps-, pe-,
// start-*, end-*, text-start, text-end) adapt automatically.
//
// Replaces: scripts/lint-logical-properties.sh

// Extension is required, not stylistic. Plugin sources are loaded by Node's
// ESM resolver as well as Bun's, and Node does not infer one. Without it the
// whole plugin set fails to load under Node, and the error names this file's
// import rather than whatever the caller was linting.
import {
  hasPhysicalProperty,
  replacePhysicalProperties,
} from "./physical-properties.ts";

export default eslintCompatPlugin({
  meta: { name: "no-physical-properties" },
  rules: {
    "no-physical-properties": {
      meta: {
        type: "problem",
        fixable: "code",
        messages: {
          physicalProperty:
            "Physical directional CSS property breaks RTL. " +
            "Use logical equivalents: " +
            "ml→ms, mr→me, pl→ps, pr→pe, " +
            "left→start, right→end, " +
            "text-left→text-start, text-right→text-end, " +
            "border-l→border-s, border-r→border-e, " +
            "rounded-l→rounded-s, rounded-r→rounded-e.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            if (hasPhysicalProperty(node.value)) {
              context.report({
                node,
                messageId: "physicalProperty",
                fix: (fixer) => {
                  const source = context.sourceCode.getText(node);
                  const replacement = replacePhysicalProperties(source);
                  return replacement === source
                    ? null
                    : fixer.replaceText(node, replacement);
                },
              });
            }
          },
          TemplateElement(node) {
            if (hasPhysicalProperty(node.value.raw)) {
              context.report({
                node,
                messageId: "physicalProperty",
                fix: (fixer) => {
                  const source = context.sourceCode.getText(node);
                  const replacement = replacePhysicalProperties(source);
                  return replacement === source
                    ? null
                    : fixer.replaceText(node, replacement);
                },
              });
            }
          },
        };
      },
    },
  },
});
