// User-entered values in web forms must carry the formatting locale into the
// money owner. This syntactic boundary detects direct DOM/Form field values;
// aliases and values returned by other functions are outside its analysis.
import { eslintCompatPlugin } from "@oxlint/plugins";

export default eslintCompatPlugin({
  meta: { name: "no-canonical-money-form-parse" },
  rules: {
    "no-canonical-money-form-parse": {
      meta: {
        type: "problem",
        messages: {
          localeParser:
            "Use parseLocaleMinorUnits with the formatting locale for user-entered money text.",
        },
      },
      create(context) {
        const canonicalNames = new Set<string>();
        return {
          ImportDeclaration(node) {
            if (node.source.value !== "@stll/money") {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                specifier.imported.name === "tryToMinorUnits"
              ) {
                canonicalNames.add(specifier.local.name);
              }
            }
          },
          CallExpression(node) {
            if (
              node.callee.type !== "Identifier" ||
              !canonicalNames.has(node.callee.name)
            ) {
              return;
            }
            const text = context.sourceCode.getText(node.arguments.at(0));
            if (/\b(?:currentTarget|target|state)\.value\b/u.test(text)) {
              context.report({ node, messageId: "localeParser" });
            }
          },
        };
      },
    },
  },
});
