// Keep Unicode normalization semantics at @stll/text-normalize. This rule is
// intentionally syntax-based: a member call with an explicit Unicode form, or
// the conventional `normalization` form variable, is unambiguously the native
// String normalization API. Node path.normalize calls are not member calls
// with one of these forms and remain outside this rule's scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode, isStringLiteral } from "./utils.ts";

const FORMS = new Set(["NFC", "NFD", "NFKC", "NFKD"]);

export default eslintCompatPlugin({
  meta: { name: "no-direct-unicode-normalize" },
  rules: {
    "no-direct-unicode-normalize": {
      meta: {
        type: "problem",
        messages: {
          direct:
            "Use normalizeUnicode() from @stll/text-normalize so Unicode normalization has one owner.",
          markStrip:
            "Use stripUnicodeMarks() from @stll/text-normalize so mark-removal semantics stay explicit.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              !isAstNode(node.callee) ||
              node.callee.type !== "MemberExpression"
            ) {
              return;
            }
            const property = getPropertyName(node.callee.property);
            if (
              (property === "replace" || property === "replaceAll") &&
              node.arguments.length >= 1
            ) {
              const pattern = context.sourceCode.getText(node.arguments[0]);
              if (
                pattern === "/\\p{M}/gu" ||
                pattern === "/\\p{M}+/gu" ||
                pattern === "/\\p{Diacritic}/gu" ||
                pattern === "/[\\u0300-\\u036f]/gu"
              ) {
                context.report({ node, messageId: "markStrip" });
              }
              return;
            }
            if (property !== "normalize" || node.arguments.length !== 1) {
              return;
            }
            const form = node.arguments[0];
            const isKnownLiteral =
              isStringLiteral(form) && FORMS.has(form.value);
            const isConventionalVariable =
              isAstNode(form) &&
              form.type === "Identifier" &&
              form.name === "normalization";
            if (isKnownLiteral || isConventionalVariable) {
              context.report({ node, messageId: "direct" });
            }
          },
        };
      },
    },
  },
});
