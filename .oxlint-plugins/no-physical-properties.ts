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

const isClassNameAttribute = (node) =>
  node?.type === "JSXAttribute" &&
  node.name.type === "JSXIdentifier" &&
  node.name.name === "className";

// Only direct JSX className values prove that a matched token is a Tailwind
// class. Other strings still receive the diagnostic, but not a potentially
// meaning-changing fix (for example, prose containing "right-click").
const isDirectClassNameValue = (node) => {
  if (isClassNameAttribute(node.parent) && node.parent.value === node) {
    return true;
  }
  if (
    node.parent?.type === "JSXExpressionContainer" &&
    node.parent.expression === node &&
    isClassNameAttribute(node.parent.parent)
  ) {
    return true;
  }
  if (node.type !== "TemplateElement") {
    return false;
  }
  const template = node.parent;
  const container = template?.parent;
  return (
    template?.type === "TemplateLiteral" &&
    container?.type === "JSXExpressionContainer" &&
    container.expression === template &&
    isClassNameAttribute(container.parent)
  );
};

const reportPhysicalProperty = (context, node) => {
  if (!isDirectClassNameValue(node)) {
    context.report({ node, messageId: "physicalProperty" });
    return;
  }
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
};

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
              reportPhysicalProperty(context, node);
            }
          },
          TemplateElement(node) {
            if (hasPhysicalProperty(node.value.raw)) {
              reportPhysicalProperty(context, node);
            }
          },
        };
      },
    },
  },
});
