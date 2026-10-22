import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import { filenameForContext, getImportedName } from "./utils.ts";

const OWNER = "apps/api/src/mcp/write-tool-authority.ts";
const AUTHORITY_MODULES = new Set([
  "@/api/mcp/write-tool-authority",
  "@/api/mcp/write-tool-authority.ts",
]);
const INTERNAL_NAMES = new Set([
  "authorizedMcpRequestContextBrand",
  "createAuthorizedMcpRequestContext",
]);

export default eslintCompatPlugin({
  meta: { name: "mcp-authorized-context-owner" },
  rules: {
    "mcp-authorized-context-owner": {
      meta: {
        type: "problem",
        messages: {
          owner:
            "Only write-tool-authority.ts may construct or export an AuthorizedMcpRequestContext brand.",
        },
      },
      createOnce(context) {
        const report = (node: Node) =>
          context.report({ node, messageId: "owner" });
        return {
          before() {
            return !filenameForContext(context).endsWith(OWNER);
          },
          ImportDeclaration(node) {
            if (
              typeof node.source.value !== "string" ||
              !AUTHORITY_MODULES.has(node.source.value)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              if (imported !== null && INTERNAL_NAMES.has(imported)) {
                report(specifier);
              }
            }
          },
          VariableDeclarator(node) {
            if (
              node.id.type === "Identifier" &&
              INTERNAL_NAMES.has(node.id.name)
            ) {
              report(node);
            }
          },
          FunctionDeclaration(node) {
            if (node.id !== null && INTERNAL_NAMES.has(node.id.name)) {
              report(node);
            }
          },
        };
      },
    },
  },
});
