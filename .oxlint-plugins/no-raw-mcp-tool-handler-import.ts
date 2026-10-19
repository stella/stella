import { eslintCompatPlugin, type Context, type Node } from "@oxlint/plugins";

import { repoRelativeFilename } from "./utils.ts";

const ALLOWED_MODULES = new Set([
  "apps/api/src/mcp/static-tool-definitions.ts",
  "apps/api/src/mcp/tools.ts",
]);
const RAW_HANDLER_NAME =
  /^(?:getStaticMcpToolHandler|[A-Z][A-Z0-9_]*_TOOL_HANDLERS)$/u;

const importedName = (specifier: Node): string | undefined => {
  if (!("imported" in specifier) || specifier.imported === null) {
    return undefined;
  }
  const imported = specifier.imported;
  if (typeof imported !== "object" || !("name" in imported)) {
    return undefined;
  }
  return typeof imported.name === "string" ? imported.name : undefined;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-mcp-tool-handler-import" },
  rules: {
    "no-raw-mcp-tool-handler-import": {
      meta: {
        type: "problem",
        messages: {
          rawHandler:
            "Use invokeStaticMcpTool instead of importing {{name}} directly.",
        },
        schema: [],
      },
      createOnce(context: Context) {
        return {
          ImportDeclaration(node: Node) {
            const filename = repoRelativeFilename(context);
            if (ALLOWED_MODULES.has(filename) || filename.includes(".test.")) {
              return;
            }
            for (const specifier of node.specifiers) {
              const name = importedName(specifier);
              if (name !== undefined && RAW_HANDLER_NAME.test(name)) {
                context.report({
                  node: specifier,
                  messageId: "rawHandler",
                  data: { name },
                });
              }
            }
          },
        };
      },
    },
  },
});
