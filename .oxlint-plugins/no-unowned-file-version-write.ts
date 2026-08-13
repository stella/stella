// Keep entity-version persistence behind explicit ownership boundaries.
//
// Ordinary and automatic file replacements use writeFileVersion. Initial entity
// creation, import, restore, deletion, and durable edit sessions receive narrow,
// reviewable capabilities for the physical mutations their lifecycles require.
// File-source writers must also request extraction in the source transaction.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  REVIEWED_VERSION_MUTATION_OWNERS,
  VERSION_WRITE_CAPABILITY,
} from "../apps/api/src/lib/entity-versions/version-write-ownership-policy.ts";
import type { VersionWriteCapability } from "../apps/api/src/lib/entity-versions/version-write-ownership-policy.ts";
import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const VERSION_WRITE_HELPERS = new Set([
  "cloneFieldsForRevision",
  "nextEntityVersionNumber",
]);

const NATIVE_EXTRACTION_REQUEST_HELPERS = new Set([
  "requestNativeExtractionRun",
  "requestNativeExtractionRuns",
]);

const isScopeIdentifier = (node: unknown): node is ESTree.IdentifierReference =>
  isIdentifier(node);

const isVersionUtilsModule = (moduleSpecifier: string): boolean =>
  moduleSpecifier === "@/api/lib/entity-versions/version-utils" ||
  /(?:^|\/)entity-versions\/version-utils(?:\.ts)?$/.test(moduleSpecifier) ||
  moduleSpecifier === "./version-utils" ||
  moduleSpecifier === "./version-utils.ts";

const isProcessExtractionModule = (moduleSpecifier: string): boolean =>
  moduleSpecifier === "@/api/lib/search/process-extraction" ||
  /(?:^|\/)search\/process-extraction(?:\.ts)?$/.test(moduleSpecifier);

const isEntitySchemaModule = (moduleSpecifier: string): boolean =>
  /(?:^|\/)db\/schema(?:\/entities)?(?:\.ts)?$/.test(moduleSpecifier);

const isMemberCall = (node: unknown, method: string): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    callee?.type === "MemberExpression" &&
    getPropertyName(callee.property) === method
  );
};

type TableBindings = {
  direct: Set<string>;
  namespaces: Set<string>;
  tableName: "entities" | "entityVersions";
};

const isTableReference = (node: unknown, bindings: TableBindings): boolean => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression)) {
    return bindings.direct.has(expression.name);
  }
  if (expression?.type !== "MemberExpression") {
    return false;
  }
  return (
    isIdentifier(expression.object) &&
    bindings.namespaces.has(expression.object.name) &&
    getPropertyName(expression.property) === bindings.tableName
  );
};

const getCurrentVersionSetTarget = (
  node: unknown,
  payloadSetsCurrentVersion: (payload: unknown) => boolean,
): unknown => {
  if (!isMemberCall(node, "set") || !isAstNode(node)) {
    return null;
  }
  const setCallee = unwrapExpression(node.callee);
  if (setCallee?.type !== "MemberExpression") {
    return null;
  }
  const updateCall = unwrapExpression(setCallee.object);
  if (!isMemberCall(updateCall, "update") || !isAstNode(updateCall)) {
    return null;
  }
  const values = unwrapExpression(
    Array.isArray(node.arguments) ? node.arguments.at(0) : null,
  );
  if (
    !payloadSetsCurrentVersion(values) ||
    !Array.isArray(updateCall.arguments)
  ) {
    return null;
  }
  return updateCall.arguments.at(0) ?? null;
};

const ownerEntryForFilename = (
  filename: string,
): readonly [string, readonly VersionWriteCapability[]] | null => {
  for (const [owner, capabilities] of Object.entries(
    REVIEWED_VERSION_MUTATION_OWNERS,
  )) {
    if (filename.endsWith(`apps/api/src/${owner}`)) {
      return [owner, capabilities];
    }
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-unowned-file-version-write" },
  rules: {
    "no-unowned-file-version-write": {
      meta: {
        type: "problem",
        messages: {
          unownedVersionWrite:
            "Direct entity-version mutation is not owned here. Use writeFileVersion for replacements or add a narrowly reviewed lifecycle capability.",
          unusedOwnerCapability:
            "The reviewed entity-version capability '{{capability}}' is no longer exercised. Remove the stale ownership grant.",
        },
        schema: [],
      },
      createOnce(context) {
        const entityBindings: TableBindings = {
          direct: new Set(),
          namespaces: new Set(),
          tableName: "entities",
        };
        const versionBindings: TableBindings = {
          direct: new Set(),
          namespaces: entityBindings.namespaces,
          tableName: "entityVersions",
        };
        const versionUtilsNamespaces = new Set<string>();
        const processExtractionNamespaces = new Set<string>();
        const nativeExtractionRequestBindings = new Set<string>();
        const observedCapabilities = new Set<VersionWriteCapability>();
        let ownerCapabilities = new Set<VersionWriteCapability>();

        const resolveVariable = (identifierNode: unknown) => {
          if (!isScopeIdentifier(identifierNode)) {
            return null;
          }
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(identifierNode);
          while (scope) {
            const variable = scope.set.get(identifierNode.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const payloadSetsCurrentVersion = (
          payload: unknown,
          seenVariables = new Set<unknown>(),
        ): boolean => {
          const expression = unwrapExpression(payload);
          if (expression?.type === "ObjectExpression") {
            if (!Array.isArray(expression.properties)) {
              return false;
            }
            return expression.properties.some((property) => {
              if (!isAstNode(property)) {
                return false;
              }
              if (property.type === "Property") {
                return getPropertyName(property.key) === "currentVersionId";
              }
              return (
                property.type === "SpreadElement" &&
                payloadSetsCurrentVersion(property.argument, seenVariables)
              );
            });
          }
          if (!isIdentifier(expression)) {
            return false;
          }

          const variable = resolveVariable(expression);
          if (variable === null || seenVariables.has(variable)) {
            return false;
          }
          seenVariables.add(variable);
          return variable.defs.some((definition) => {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              return false;
            }
            return payloadSetsCurrentVersion(
              definition.node.init,
              seenVariables,
            );
          });
        };

        const claimCapability = (
          capability: VersionWriteCapability,
          node: unknown,
        ) => {
          if (ownerCapabilities.has(capability)) {
            observedCapabilities.add(capability);
            return;
          }
          if (isAstNode(node)) {
            context.report({ node, messageId: "unownedVersionWrite" });
          }
        };

        return {
          before() {
            entityBindings.direct.clear();
            entityBindings.namespaces.clear();
            versionBindings.direct.clear();
            versionUtilsNamespaces.clear();
            processExtractionNamespaces.clear();
            nativeExtractionRequestBindings.clear();
            observedCapabilities.clear();
            const filename = filenameForContext(context);
            const ownerEntry = ownerEntryForFilename(filename);
            ownerCapabilities =
              ownerEntry === null ? new Set() : new Set(ownerEntry[1]);
            return (
              filename.includes("apps/api/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/no-unowned-file-version-write.fixture.ts",
              )
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }

            if (isEntitySchemaModule(node.source.value)) {
              for (const specifier of node.specifiers) {
                if (
                  isAstNode(specifier) &&
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  entityBindings.namespaces.add(specifier.local.name);
                  continue;
                }
                const importedName = getImportedName(specifier);
                const localName = getImportLocalName(specifier);
                if (importedName === "entities" && localName !== null) {
                  entityBindings.direct.add(localName);
                } else if (
                  importedName === "entityVersions" &&
                  localName !== null
                ) {
                  versionBindings.direct.add(localName);
                }
              }
            }

            if (isProcessExtractionModule(node.source.value)) {
              for (const specifier of node.specifiers) {
                if (
                  isAstNode(specifier) &&
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  processExtractionNamespaces.add(specifier.local.name);
                  continue;
                }
                const importedName = getImportedName(specifier);
                if (
                  importedName !== null &&
                  NATIVE_EXTRACTION_REQUEST_HELPERS.has(importedName)
                ) {
                  const localName = getImportLocalName(specifier);
                  if (localName !== null) {
                    nativeExtractionRequestBindings.add(localName);
                  }
                }
              }
            }

            if (!isVersionUtilsModule(node.source.value)) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                isAstNode(specifier) &&
                specifier.type === "ImportNamespaceSpecifier" &&
                isIdentifier(specifier.local)
              ) {
                versionUtilsNamespaces.add(specifier.local.name);
                continue;
              }
              const importedName = getImportedName(specifier);
              if (
                importedName !== null &&
                VERSION_WRITE_HELPERS.has(importedName)
              ) {
                claimCapability(
                  VERSION_WRITE_CAPABILITY.USE_VERSION_UTILS,
                  specifier,
                );
              }
            }
          },
          VariableDeclarator(node) {
            if (isIdentifier(node.id)) {
              const initializer = unwrapExpression(node.init);
              if (
                isIdentifier(initializer) &&
                entityBindings.namespaces.has(initializer.name)
              ) {
                entityBindings.namespaces.add(node.id.name);
              }
              if (isTableReference(node.init, entityBindings)) {
                entityBindings.direct.add(node.id.name);
              }
              if (isTableReference(node.init, versionBindings)) {
                versionBindings.direct.add(node.id.name);
              }
              return;
            }

            const initializer = unwrapExpression(node.init);
            if (
              !isAstNode(node.id) ||
              node.id.type !== "ObjectPattern" ||
              !Array.isArray(node.id.properties) ||
              !isIdentifier(initializer) ||
              !entityBindings.namespaces.has(initializer.name)
            ) {
              return;
            }

            for (const property of node.id.properties) {
              if (!isAstNode(property)) {
                continue;
              }
              if (property.type === "RestElement") {
                if (isIdentifier(property.argument)) {
                  entityBindings.namespaces.add(property.argument.name);
                }
                continue;
              }
              if (property.type !== "Property") {
                continue;
              }
              const tableName = getPropertyName(property.key);
              const value = unwrapExpression(property.value);
              const local =
                value?.type === "AssignmentPattern"
                  ? unwrapExpression(value.left)
                  : value;
              if (!isIdentifier(local)) {
                continue;
              }
              if (tableName === "entities") {
                entityBindings.direct.add(local.name);
              } else if (tableName === "entityVersions") {
                versionBindings.direct.add(local.name);
              }
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            const isNativeExtractionRequest =
              (isIdentifier(callee) &&
                nativeExtractionRequestBindings.has(callee.name)) ||
              (callee?.type === "MemberExpression" &&
                isIdentifier(callee.object) &&
                processExtractionNamespaces.has(callee.object.name) &&
                NATIVE_EXTRACTION_REQUEST_HELPERS.has(
                  getPropertyName(callee.property) ?? "",
                ));
            if (isNativeExtractionRequest) {
              claimCapability(
                VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
                node,
              );
            }

            if (isMemberCall(node, "insert") && Array.isArray(node.arguments)) {
              const table = node.arguments.at(0);
              if (isTableReference(table, versionBindings)) {
                claimCapability(
                  VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
                  node,
                );
              }
            }

            const currentVersionTarget = getCurrentVersionSetTarget(
              node,
              payloadSetsCurrentVersion,
            );
            if (isTableReference(currentVersionTarget, entityBindings)) {
              claimCapability(
                VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
                node,
              );
            }

            if (
              callee?.type === "MemberExpression" &&
              isIdentifier(callee.object) &&
              versionUtilsNamespaces.has(callee.object.name)
            ) {
              const helperName = getPropertyName(callee.property);
              if (
                helperName !== null &&
                VERSION_WRITE_HELPERS.has(helperName)
              ) {
                claimCapability(
                  VERSION_WRITE_CAPABILITY.USE_VERSION_UTILS,
                  node,
                );
              }
            }
          },
          "Program:exit"(node) {
            for (const capability of ownerCapabilities) {
              if (!observedCapabilities.has(capability)) {
                context.report({
                  node,
                  messageId: "unusedOwnerCapability",
                  data: { capability },
                });
              }
            }
          },
        };
      },
    },
  },
});
