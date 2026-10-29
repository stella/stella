// Keep repository-relative identifiers behind the portable-path owner. Node's
// path.relative() returns platform separators, so its output is not stable.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import type { ScopeContext } from "./utils.ts";
import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  patternKeyFor,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
  staticStringValue,
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
const PORTABLE_STRING_METHODS = new Set([
  "endsWith",
  "includes",
  "join",
  "split",
  "startsWith",
]);

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

const isDefaultedPathParameter = (
  variable: Variable | null,
  name: string,
  isPathObject: (node: unknown) => boolean,
): boolean => {
  const definition = variable?.defs.at(0);
  if (
    variable?.defs.length !== 1 ||
    definition?.type !== "Parameter" ||
    !isAstNode(definition.node) ||
    !Array.isArray(definition.node.params)
  ) {
    return false;
  }
  return definition.node.params.some(
    (parameter) =>
      isAstNode(parameter) &&
      parameter.type === "AssignmentPattern" &&
      isIdentifierReference(parameter.left) &&
      parameter.left.name === name &&
      isPathObject(parameter.right),
  );
};

const portableIdentifierMixer = (
  context: ScopeContext,
  isPathSeparator: (node: unknown) => boolean,
) => {
  const isPortableIdentifier = (
    node: unknown,
    seen = new Set<Variable>(),
  ): boolean => {
    if (!isAstNode(node)) {
      return false;
    }
    if (node.type === "CallExpression") {
      const binding = resolveImportedExpressionForEnforcement(
        context,
        node.callee,
      );
      return (
        binding?.source === "@stll/portable-path" &&
        binding.imported === "repoRelativePath"
      );
    }
    if (!isIdentifierReference(node)) {
      return false;
    }
    const variable = resolveVariable(context, node);
    if (variable === null || seen.has(variable)) {
      return false;
    }
    seen.add(variable);
    const initializer = stableInitializer(variable);
    return initializer !== null && isPortableIdentifier(initializer, seen);
  };
  return (node: unknown): boolean => {
    if (!isAstNode(node)) {
      return false;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      return (
        (isPortableIdentifier(node.left) && isPathSeparator(node.right)) ||
        (isPathSeparator(node.left) && isPortableIdentifier(node.right))
      );
    }
    if (node.type === "TemplateLiteral" && Array.isArray(node.expressions)) {
      return (
        node.expressions.some((expression) =>
          isPortableIdentifier(expression),
        ) && node.expressions.some(isPathSeparator)
      );
    }
    if (
      node.type !== "CallExpression" ||
      !isAstNode(node.callee) ||
      node.callee.type !== "MemberExpression" ||
      !PORTABLE_STRING_METHODS.has(
        getPropertyName(node.callee.property) ?? "",
      ) ||
      !Array.isArray(node.arguments)
    ) {
      return false;
    }
    return (
      (isPortableIdentifier(node.callee.object) &&
        node.arguments.some(isPathSeparator)) ||
      (isPathSeparator(node.callee.object) &&
        node.arguments.some((argument) => isPortableIdentifier(argument)))
    );
  };
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
        const importedPathExpression = (node: unknown, imported: string) => {
          const binding = resolveImportedExpressionForEnforcement(
            context,
            node,
          );
          return (
            binding !== null &&
            PATH_MODULES.has(binding.source) &&
            binding.imported === imported
          );
        };
        const pathObjectImport = (node: unknown): boolean => {
          if (!isIdentifierReference(node)) {
            return false;
          }
          const variable = variableFor(node);
          const imported = importedPathBinding(variable);
          if (
            imported !== null &&
            (imported.type === "ImportDefaultSpecifier" ||
              imported.type === "ImportNamespaceSpecifier" ||
              PATH_PLATFORMS.has(imported.importedName ?? ""))
          ) {
            return true;
          }
          return isDefaultedPathParameter(
            variable,
            node.name,
            pathObjectImport,
          );
        };
        const isDestructuredPathMember = (
          variable: Variable | null,
          member: string,
        ): boolean => {
          const definition = variable?.defs.at(0);
          return (
            variable?.defs.length === 1 &&
            definition?.type === "Variable" &&
            isAstNode(definition.node) &&
            definition.node.type === "VariableDeclarator" &&
            isAstNode(definition.node.id) &&
            definition.node.id.type === "ObjectPattern" &&
            patternKeyFor(definition.node.id, definition.name) === member &&
            stableInitializer(variable) !== null &&
            pathObjectImport(definition.node.init)
          );
        };
        const isPathRelative = (callee: unknown): boolean => {
          if (isIdentifierReference(callee)) {
            if (importedPathExpression(callee, "relative")) {
              return true;
            }
            const variable = variableFor(callee);
            if (isDestructuredPathMember(variable, "relative")) {
              return true;
            }
            const initializer =
              variable === null ? null : stableInitializer(variable);
            return initializer !== null && isPathRelative(initializer);
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
        const isPathSeparator = (node: unknown): boolean => {
          if (isIdentifierReference(node)) {
            if (importedPathExpression(node, "sep")) {
              return true;
            }
            const variable = variableFor(node);
            if (isDestructuredPathMember(variable, "sep")) {
              return true;
            }
            const initializer =
              variable === null ? null : stableInitializer(variable);
            return initializer !== null && isPathSeparator(initializer);
          }
          if (
            !isAstNode(node) ||
            node.type !== "MemberExpression" ||
            getPropertyName(node.property) !== "sep"
          ) {
            return false;
          }
          if (pathObjectImport(node.object)) {
            return true;
          }
          const object = node.object;
          return (
            isAstNode(object) &&
            object.type === "MemberExpression" &&
            PATH_PLATFORMS.has(getPropertyName(object.property) ?? "") &&
            pathObjectImport(object.object)
          );
        };
        const isNativeEscapePrefix = (node: unknown): boolean => {
          if (staticStringValue(node) === "..\\") {
            return true;
          }
          if (!isAstNode(node) || node.type !== "TemplateLiteral") {
            return false;
          }
          const { expressions, quasis } = node;
          if (
            !Array.isArray(expressions) ||
            expressions.length !== 1 ||
            !Array.isArray(quasis) ||
            quasis.length !== 2
          ) {
            return false;
          }
          const head = quasis.at(0);
          const tail = quasis.at(1);
          const cooked = (quasi: unknown): string | null => {
            if (!isAstNode(quasi)) {
              return null;
            }
            const value = quasi.value;
            if (
              typeof value !== "object" ||
              value === null ||
              !("cooked" in value)
            ) {
              return null;
            }
            return typeof value.cooked === "string" ? value.cooked : null;
          };
          return (
            cooked(head) === ".." &&
            cooked(tail) === "" &&
            isPathSeparator(expressions.at(0))
          );
        };
        const isNativeEscapeCheck = (node: unknown): boolean =>
          isAstNode(node) &&
          node.type === "MemberExpression" &&
          getPropertyName(node.property) === "startsWith";
        const mixesPortableIdentifierAndSeparator = portableIdentifierMixer(
          context,
          isPathSeparator,
        );
        return {
          before() {
            isOwner = filenameForContext(context).includes(OWNER_PATH);
          },
          CallExpression(node) {
            if (!isOwner && isPathRelative(node.callee)) {
              context.report({ node, messageId: "noRawPathRelative" });
            }
            if (
              !isOwner &&
              isNativeEscapeCheck(node.callee) &&
              Array.isArray(node.arguments) &&
              isNativeEscapePrefix(node.arguments.at(0))
            ) {
              context.report({
                node,
                message:
                  "Do not build path escape checks from native separators. Use isPathInside from @stll/portable-path.",
              });
            }
            if (!isOwner && mixesPortableIdentifierAndSeparator(node)) {
              context.report({
                node,
                message:
                  "Do not combine native path separators with portable repository-relative identifiers. Use a forward slash.",
              });
            }
          },
          "BinaryExpression, TemplateLiteral"(node) {
            if (!isOwner && mixesPortableIdentifierAndSeparator(node)) {
              context.report({
                node,
                message:
                  "Do not combine native path separators with portable repository-relative identifiers. Use a forward slash.",
              });
            }
          },
        };
      },
    },
  },
});
