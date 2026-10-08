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

const LONE_SECTION_SIGN =
  /^\s*(?:§|\\u00a7|\\u\{a7\}|&sect;|&#167;|&#x0*a7;)+\s*$/iu;

const isLoneSectionSign = (value: string) => LONE_SECTION_SIGN.test(value);

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
            if (isLoneSectionSign(node.value)) {
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
