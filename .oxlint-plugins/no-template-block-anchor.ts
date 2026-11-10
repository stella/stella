// Case-law ingestion replaces positional block anchors with stable ones
// (`withStableBlockAnchors` in @stll/legal-ast/stable-block-anchors), and it
// recognises a positional anchor by one grammar. An anchor a parser spells
// by hand in another shape escapes that replacement and shifts on every
// reparse, so positional anchors are minted only by `positionalBlockAnchor`.
//
// Flags a template literal whose text right before an interpolation is a
// kind letter (`p`, `h`, `t`) at the start or after `-`, optionally followed
// by `-`: `p-${index}`, `${prefix}-p${number}`, `${prefix}h-${n}`.
// Accepts publisher spellings (`point${n}`, `fn-${id}`) and prefixing an
// existing anchor (`${prefix}${block.anchorId}`). The analysis is syntactic:
// a kind letter held in a constant (`${KIND}-${n}`) is outside it.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

const POSITIONAL_KIND_BEFORE_INTERPOLATION = /(?:^|-)[pht]-?$/u;

const cookedText = (quasi: unknown): string | null => {
  if (!isAstNode(quasi) || quasi.type !== "TemplateElement") {
    return null;
  }
  const value = quasi.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if ("cooked" in value && typeof value.cooked === "string") {
    return value.cooked;
  }
  return "raw" in value && typeof value.raw === "string" ? value.raw : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-template-block-anchor" },
  rules: {
    "no-template-block-anchor": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          positional:
            "Mint a positional block anchor with positionalBlockAnchor from @stll/legal-ast/stable-block-anchors; ingestion replaces only anchors in its shape with stable ones.",
        },
      },
      createOnce(context) {
        return {
          TemplateLiteral(node) {
            if (!isAstNode(node) || !Array.isArray(node.quasis)) {
              return;
            }
            const interpolations = Array.isArray(node.expressions)
              ? node.expressions.length
              : 0;
            const minted = node.quasis
              .slice(0, interpolations)
              .some((quasi: unknown) => {
                const text = cookedText(quasi);
                return (
                  text !== null &&
                  POSITIONAL_KIND_BEFORE_INTERPOLATION.test(text)
                );
              });
            if (minted) {
              context.report({ node, messageId: "positional" });
            }
          },
        };
      },
    },
  },
});
