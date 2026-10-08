// A lone section sign in markup is a placeholder for the stella logo that
// never got replaced: it renders as a literal '§' where the mark belongs.
// Legal text keeps the glyph next to its number ("§ 10", "§§ 2-4"), so only
// markup whose whole content is the glyph is flagged.
//
// Flagged:
//   <div className="mark">§</div>
//   <span>{"§"}</span>
//   <Badge label="&sect;" />
// Allowed:
//   <StellaMark className="size-6" />
//   <span>§ 10 or a heading</span>
//   const marker = "§";            (parser data, not markup)
//
// Static HTML pages are outside oxlint; apps/desktop/tests covers them.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

const LONE_SECTION_SIGN =
  /^\s*(?:§|\\u00a7|\\u\{a7\}|&sect;|&#167;|&#x0*a7;)+\s*$/iu;

const isLoneSectionSign = (value: string) => LONE_SECTION_SIGN.test(value);

// Whitespace text and JSX comments render nothing next to the glyph.
const rendersNothing = (child: unknown) =>
  isAstNode(child) &&
  ((child.type === "JSXText" &&
    typeof child.value === "string" &&
    child.value.trim() === "") ||
    (child.type === "JSXExpressionContainer" &&
      isAstNode(child.expression) &&
      child.expression.type === "JSXEmptyExpression"));

// A child is the element's whole content only when no sibling renders: "§ <a>10</a>" and {"§"} 10 are legal references split across
// children, not a placeholder.
const isOnlyChild = (node: { parent?: unknown }) => {
  const { parent } = node;
  if (
    !isAstNode(parent) ||
    (parent.type !== "JSXElement" && parent.type !== "JSXFragment") ||
    !Array.isArray(parent.children)
  ) {
    return true;
  }
  return parent.children.every(
    (child: unknown) => child === node || rendersNothing(child),
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-section-sign-glyph" },
  rules: {
    "no-section-sign-glyph": {
      meta: {
        type: "problem",
        messages: {
          loneSectionSign:
            "A lone '§' in markup renders as a literal glyph. Did you mean " +
            "the stella logo? Render `StellaMark` from '@stll/ui/stella-mark' " +
            "(packages/ui/src/components/stella-mark.tsx); a static HTML page " +
            "inlines the same SVG paths. Legal text keeps the sign next to " +
            "its number, e.g. '§ 10'.",
        },
      },
      createOnce(context) {
        return {
          JSXText(node) {
            if (isLoneSectionSign(node.value) && isOnlyChild(node)) {
              context.report({ node, messageId: "loneSectionSign" });
            }
          },
          JSXAttribute(node) {
            const { value } = node;
            if (
              value?.type === "Literal" &&
              typeof value.value === "string" &&
              isLoneSectionSign(value.value)
            ) {
              context.report({ node: value, messageId: "loneSectionSign" });
            }
          },
          JSXExpressionContainer(node) {
            const { expression } = node;
            if (!isOnlyChild(node)) {
              return;
            }
            if (
              expression.type === "Literal" &&
              typeof expression.value === "string" &&
              isLoneSectionSign(expression.value)
            ) {
              context.report({
                node: expression,
                messageId: "loneSectionSign",
              });
              return;
            }
            if (
              expression.type === "TemplateLiteral" &&
              expression.expressions.length === 0 &&
              isLoneSectionSign(expression.quasis[0]?.value.cooked ?? "")
            ) {
              context.report({
                node: expression,
                messageId: "loneSectionSign",
              });
            }
          },
        };
      },
    },
  },
});
