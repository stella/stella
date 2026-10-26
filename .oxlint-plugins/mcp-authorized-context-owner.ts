import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import {
  canonicalModuleId,
  getImportedName,
  getPropertyName,
  isTestFile,
  repoRelativeFilename,
  staticStringValue,
} from "./utils.ts";

const OWNER = "apps/api/src/mcp/write-tool-authority.ts";
const AUTHORITY_MODULE = OWNER.slice(0, -3);
const INTERNAL_NAMES = new Set([
  "authorizedMcpRequestContextBrand",
  "authorizedMcpContextForTest",
  "createAuthorizedMcpRequestContext",
]);
const TEST_HELPER_MODULE = "apps/api/src/tests/helpers/authorized-mcp-context";
const TEST_HELPER = "authorizedMcpContextForTest";

export default eslintCompatPlugin({
  meta: { name: "mcp-authorized-context-owner" },
  rules: {
    "mcp-authorized-context-owner": {
      meta: {
        type: "problem",
        messages: {
          owner:
            "Only write-tool-authority.ts may construct or export an AuthorizedMcpRequestContext brand.",
          testOnly:
            "authorizedMcpContextForTest may only be imported by tests and test helpers.",
        },
      },
      createOnce(context) {
        let filename = "";
        const report = (node: Node) =>
          context.report({ node, messageId: "owner" });
        const checkSource = (
          node: Node,
          source: string,
          names: readonly string[] | null,
        ) => {
          const moduleId = canonicalModuleId(source, filename);
          if (moduleId === TEST_HELPER_MODULE) {
            if (!isTestFile(filename)) {
              context.report({ node, messageId: "testOnly" });
            }
            return;
          }
          if (moduleId !== AUTHORITY_MODULE) {
            return;
          }
          if (
            canonicalModuleId(filename, filename) === TEST_HELPER_MODULE &&
            names?.every((name) => name === TEST_HELPER)
          ) {
            return;
          }
          if (
            names === null ||
            names.some((name) => INTERNAL_NAMES.has(name))
          ) {
            report(node);
          }
        };
        return {
          before() {
            filename = repoRelativeFilename(context);
            return filename !== OWNER;
          },
          ImportDeclaration(node) {
            if (typeof node.source.value !== "string") {
              return;
            }
            if (node.specifiers.length === 0) {
              checkSource(node, node.source.value, []);
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              checkSource(
                specifier,
                node.source.value,
                imported === null ? null : [imported],
              );
            }
          },
          ExportNamedDeclaration(node) {
            if (node.source === null) {
              return;
            }
            for (const specifier of node.specifiers) {
              const local = getPropertyName(specifier.local);
              checkSource(
                specifier,
                node.source.value,
                local === null ? null : [local],
              );
            }
          },
          ExportAllDeclaration(node) {
            checkSource(node, node.source.value, null);
          },
          ImportExpression(node) {
            const source = staticStringValue(node.source);
            if (source !== null) {
              checkSource(node, source, null);
            }
          },
          CallExpression(node) {
            const source = staticStringValue(node.arguments.at(0));
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "require" &&
              source !== null
            ) {
              checkSource(node, source, null);
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
