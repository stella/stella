// User-entered values in web forms must carry the formatting locale into the
// money owner. This syntactic boundary detects direct DOM/Form field values;
// aliases and values returned by other functions are outside its analysis.
import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import { isIdentifierReference, resolveVariable } from "./utils.ts";

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
      createOnce(context) {
        let canonicalBindings = new Set<Variable>();
        return {
          Program() {
            canonicalBindings = new Set();
          },
          ImportDeclaration(node) {
            if (node.source.value !== "@stll/money") {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                (specifier.imported.name === "tryToMinorUnits" ||
                  specifier.imported.name === "toMinorUnits") &&
                isIdentifierReference(specifier.local)
              ) {
                const binding = resolveVariable(context, specifier.local);
                if (binding !== null) {
                  canonicalBindings.add(binding);
                }
              }
            }
          },
          CallExpression(node) {
            if (!isIdentifierReference(node.callee)) {
              return;
            }
            const binding = resolveVariable(context, node.callee);
            if (binding === null || !canonicalBindings.has(binding)) {
              return;
            }
            const text = context.sourceCode.getText(node.arguments.at(0));
            if (
              /\b(?:currentTarget|target|state|dataset)\.value\b|\b(?:amountInputValue|draft|input)\b/u.test(
                text,
              )
            ) {
              context.report({ node, messageId: "localeParser" });
            }
          },
        };
      },
    },
  },
});
