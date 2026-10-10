// Keep repository-relative identifiers behind the portable-path owner. Node's
// path.relative() returns platform separators, so its output is not stable.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
} from "./utils.ts";

const PATH_MODULES = new Set([
  "node:path",
  "node:path/posix",
  "node:path/win32",
  "path",
  "path/posix",
  "path/win32",
]);
const PATH_PLATFORMS = new Set(["posix", "win32"]);
const OWNER_PATH = "/packages/portable-path/";

const importedPathBinding = (
  variable: Variable | null,
): { importedName: string | null; type: string } | null => {
  if (variable === null) {
    return null;
  }
  for (const definition of variable.defs) {
    if (
      definition.type !== "ImportBinding" ||
      !isAstNode(definition.node) ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "ImportDeclaration" ||
      !isStringLiteral(definition.parent.source) ||
      !PATH_MODULES.has(definition.parent.source.value)
    ) {
      continue;
    }
    return {
      importedName: getImportedName(definition.node),
      type: definition.node.type,
    };
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-path-relative" },
  rules: {
    "no-raw-path-relative": {
      meta: {
        type: "problem",
        messages: {
          noRawPathRelative:
            "Do not call Node path.relative() directly. Use repoRelativePath() for portable identifiers or isPathInside() for containment.",
        },
      },
      createOnce(context) {
        let isOwner = false;
        const variableFor = (node: unknown): Variable | null =>
          isIdentifierReference(node) ? resolveVariable(context, node) : null;
        const pathObjectImport = (node: unknown): boolean => {
          if (!isIdentifierReference(node)) {
            return false;
          }
          const imported = importedPathBinding(variableFor(node));
          return (
            imported !== null &&
            (imported.type === "ImportDefaultSpecifier" ||
              imported.type === "ImportNamespaceSpecifier" ||
              PATH_PLATFORMS.has(imported.importedName ?? ""))
          );
        };
        const isPathRelative = (callee: unknown): boolean => {
          if (isIdentifierReference(callee)) {
            return (
              importedPathBinding(variableFor(callee))?.importedName ===
              "relative"
            );
          }
          if (
            !isAstNode(callee) ||
            callee.type !== "MemberExpression" ||
            getPropertyName(callee.property) !== "relative"
          ) {
            return false;
          }
          if (pathObjectImport(callee.object)) {
            return true;
          }
          const object = callee.object;
          return (
            isAstNode(object) &&
            object.type === "MemberExpression" &&
            PATH_PLATFORMS.has(getPropertyName(object.property) ?? "") &&
            pathObjectImport(object.object)
          );
        };
        return {
          before() {
            isOwner = filenameForContext(context).includes(OWNER_PATH);
          },
          CallExpression(node) {
            if (!isOwner && isPathRelative(node.callee)) {
              context.report({ node, messageId: "noRawPathRelative" });
            }
          },
        };
      },
    },
  },
});
