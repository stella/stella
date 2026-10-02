import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode, isImportedFrom } from "./utils.ts";

// These three boundaries decide whether a property may be edited or deleted.
// Requiring an actual call (not merely an import) keeps their classification
// at the shared owner. Runtime file literals would recreate that policy.
const OWNERS = [
  "apps/api/src/handlers/properties/update.ts",
  "apps/api/src/handlers/properties/delete.ts",
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/property-popover.logic.ts",
];
const FIXTURE =
  ".oxlint-plugins/__fixtures__/require-file-property-policy.fixture.ts";
const POLICY_EXPORTS = new Set(["isFileProperty"]);

export default eslintCompatPlugin({
  meta: { name: "require-file-property-policy" },
  rules: {
    "require-file-property-policy": {
      meta: {
        type: "problem",
        messages: {
          policy: "Use isFileProperty from @stll/api-contract/property-policy.",
        },
      },
      createOnce(context) {
        let usesPolicy = false;
        return {
          before() {
            usesPolicy = false;
            const filename = filenameForContext(context);
            return [...OWNERS, FIXTURE].some((owner) =>
              filename.endsWith(owner),
            );
          },
          CallExpression(node) {
            if (
              isImportedFrom({
                context,
                node: node.callee,
                modules: ["@stll/api-contract/property-policy"],
                names: POLICY_EXPORTS,
              })
            ) {
              usesPolicy = true;
            }
          },
          Literal(node) {
            if (node.value !== "file") {
              return;
            }
            if (
              isAstNode(node.parent) &&
              node.parent.type === "TSLiteralType"
            ) {
              return;
            }
            context.report({ node, messageId: "policy" });
          },
          "Program:exit"(node) {
            if (!usesPolicy) {
              context.report({ node, messageId: "policy" });
            }
          },
        };
      },
    },
  },
});
