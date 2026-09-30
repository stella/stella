// Content retention belongs to the final persisted payload, never a parser's
// intermediate AST or its selected source subtree.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  canonicalModuleId,
  filenameForContext,
  getImportedName,
  isIdentifier,
  isStringLiteral,
  memberPropertyName,
  repoRelativeFilename,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-parser-text-validation";
const VALIDATOR_MODULE = "apps/api/src/lib/legal-search/parsers/validate-ast";
const FIXTURE =
  ".oxlint-plugins/__fixtures__/no-parser-text-validation.fixture.ts";

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          parserValidation:
            "Validate text retention at the pipeline's final persisted payload boundary; parsers must not import or invoke validateAndLog.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE) ||
              (filename.includes(
                "apps/api/src/handlers/case-law/ingestion/parsers/",
              ) &&
                !filename.endsWith(".test.ts"))
            );
          },
          ImportDeclaration(node) {
            if (!isStringLiteral(node.source) || node.importKind === "type") {
              return;
            }
            const isValidatorModule =
              canonicalModuleId(
                node.source.value,
                repoRelativeFilename(context),
              ) === VALIDATOR_MODULE;
            for (const specifier of node.specifiers) {
              if (
                specifier.importKind !== "type" &&
                ((isValidatorModule &&
                  specifier.type === "ImportNamespaceSpecifier") ||
                  getImportedName(specifier) === "validateAndLog")
              ) {
                context.report({
                  node: specifier,
                  messageId: "parserValidation",
                });
              }
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            const imported = resolveImport(context, callee);
            if (imported?.imported === "validateAndLog") {
              context.report({ node, messageId: "parserValidation" });
              return;
            }
            if (
              isIdentifier(callee, "validateAndLog") ||
              (callee?.type === "MemberExpression" &&
                memberPropertyName(callee) === "validateAndLog")
            ) {
              context.report({ node, messageId: "parserValidation" });
            }
          },
        };
      },
    },
  },
});
