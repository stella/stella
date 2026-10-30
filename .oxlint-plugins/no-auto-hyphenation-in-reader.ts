import { eslintCompatPlugin } from "@oxlint/plugins";

const SPLIT = /[\s"'`{}()]+/u;
const AUTO_HYPHENATION = /(?:^|:)hyphens-auto!?$/u;
const ARBITRARY_AUTO_HYPHENATION = /(?:^|:)\[hyphens:auto\]!?$/u;

const usesAutomaticHyphenation = (value: string): boolean =>
  value.split(SPLIT).some((token) => {
    const withoutBang = token.endsWith("!") ? token.slice(0, -1) : token;
    return (
      AUTO_HYPHENATION.test(withoutBang) ||
      ARBITRARY_AUTO_HYPHENATION.test(withoutBang)
    );
  });

export default eslintCompatPlugin({
  meta: { name: "no-auto-hyphenation-in-reader" },
  rules: {
    "no-auto-hyphenation-in-reader": {
      meta: {
        type: "problem",
        messages: {
          autoHyphenation:
            "Reader text must not enable automatic hyphenation; keep word breaks under the document's control.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (
              typeof node.value === "string" &&
              usesAutomaticHyphenation(node.value)
            ) {
              context.report({ node, messageId: "autoHyphenation" });
            }
          },
          TemplateElement(node) {
            if (usesAutomaticHyphenation(node.value.raw)) {
              context.report({ node, messageId: "autoHyphenation" });
            }
          },
        };
      },
    },
  },
});
