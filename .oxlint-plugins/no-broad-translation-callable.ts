// Forbid passing the application's full overloaded translation callable across
// helper boundaries. `use-intl` models that callable as thousands of key- and
// argument-specific signatures. Comparing it with a helper annotation such as
// `(key: TranslationKey) => string` can make one assignability check consume
// minutes while aggregate TypeScript instantiation counters remain unchanged.
//
// Flagged:
//   type Translator = (key: TranslationKey) => string;
//   type Translator = ReturnType<typeof useTranslations>;
//   type Translator = ReturnType<typeof getTranslator>;
//
// Allowed:
//   type Translator = (key: OAuthScopeLabel) => string; // narrow key union
//   type Translator = ReturnType<typeof useTranslations<"feature">>;
//   const helper = (message: string) => message;         // translated at caller
//   const keys = { title: "feature.title" } as const
//     satisfies Record<string, TranslationKey>;          // data, not a callable

import { eslintCompatPlugin, type ESTree, type Scope } from "@oxlint/plugins";

const isIdentifierNamed = (node, name: string): boolean =>
  node?.type === "Identifier" && node.name === name;

const isBroadTranslatorName = (node): boolean =>
  isIdentifierNamed(node, "getTranslator") ||
  isIdentifierNamed(node, "getTranslations") ||
  isIdentifierNamed(node, "useTranslations");

const isTranslationTypeModule = (source: string): boolean =>
  source.endsWith("/i18n/types") || source.endsWith("/i18n/utils");

const translationKeyTypeNames = new Set(["TranslationKey"]);
const broadTranslatorMemberNames = new Set([
  "getTranslator",
  "getTranslations",
  "useTranslations",
]);

const unwrapTypeAnnotation = (node) =>
  node?.type === "TSTypeAnnotation" ? node.typeAnnotation : node;

const qualifiedNameRoot = (node) => {
  if (node?.type === "Identifier") {
    return node;
  }
  if (node?.type === "TSQualifiedName") {
    return qualifiedNameRoot(node.left);
  }
  return null;
};

const isQualifiedNamespaceMember = (
  node,
  namespaceVariables: Set<unknown>,
  memberNames: Set<string>,
  resolveVariable,
): boolean => {
  const root = qualifiedNameRoot(node);
  const variable = root ? resolveVariable(root) : null;
  return (
    node?.type === "TSQualifiedName" &&
    node.right?.type === "Identifier" &&
    memberNames.has(node.right.name) &&
    variable !== null &&
    namespaceVariables.has(variable)
  );
};

const isBroadTranslatorReturnType = (
  node,
  broadTranslatorTypeNames: Set<string>,
  broadTranslatorNamespaceVariables: Set<unknown>,
  resolveVariable,
): boolean => {
  if (
    node.type !== "TSTypeReference" ||
    !isIdentifierNamed(node.typeName, "ReturnType")
  ) {
    return false;
  }
  const queriedType = node.typeArguments?.params?.at(0);
  return (
    queriedType?.type === "TSTypeQuery" &&
    (queriedType.typeArguments?.params?.length ?? 0) === 0 &&
    ((queriedType.exprName?.type === "Identifier" &&
      broadTranslatorTypeNames.has(queriedType.exprName.name)) ||
      isQualifiedNamespaceMember(
        queriedType.exprName,
        broadTranslatorNamespaceVariables,
        broadTranslatorMemberNames,
        resolveVariable,
      ))
  );
};

const isCanonicalTranslationKeyDerivation = (node): boolean => {
  const returnTypeArguments = node?.parent;
  const parametersReference = returnTypeArguments?.parent;
  const indexedAccess = parametersReference?.parent;
  const alias = indexedAccess?.parent;

  return (
    returnTypeArguments?.type === "TSTypeParameterInstantiation" &&
    returnTypeArguments.params?.length === 1 &&
    returnTypeArguments.params.at(0) === node &&
    parametersReference?.type === "TSTypeReference" &&
    isIdentifierNamed(parametersReference.typeName, "Parameters") &&
    parametersReference.typeArguments === returnTypeArguments &&
    indexedAccess?.type === "TSIndexedAccessType" &&
    indexedAccess.objectType === parametersReference &&
    indexedAccess.indexType?.type === "TSLiteralType" &&
    indexedAccess.indexType.literal?.type === "Literal" &&
    indexedAccess.indexType.literal.value === 0 &&
    alias?.type === "TSTypeAliasDeclaration" &&
    isIdentifierNamed(alias.id, "TranslationKey") &&
    alias.typeAnnotation === indexedAccess
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-broad-translation-callable" },
  rules: {
    "no-broad-translation-callable": {
      meta: {
        type: "problem",
        messages: {
          broadAliasExport:
            "Do not export an alias of the full TranslationKey union; consumers could reintroduce a broad translation callable under a hidden name.",
          broadCallable:
            "Do not pass the full use-intl translator across a helper boundary; translate fixed keys at the UI call site, pass plain strings, or expose a narrow key union.",
        },
      },
      createOnce(context) {
        const broadTranslatorTypeNames = new Set([
          "getTranslator",
          "getTranslations",
          "useTranslations",
        ]);
        const broadKeyVariables = new Set();
        const broadKeyNamespaceVariables = new Set();
        const broadTranslatorNamespaceVariables = new Set();
        const typeAliases = new Array<ESTree.TSTypeAliasDeclaration>();
        const broadParameterCandidates = new Array<
          | ESTree.TSCallSignatureDeclaration
          | ESTree.TSFunctionType
          | ESTree.TSMethodSignature
        >();
        const broadReturnTypeCandidates = new Array<ESTree.TSTypeReference>();
        const exportedAliasNodes = new Map<
          ESTree.TSTypeAliasDeclaration,
          ESTree.ExportNamedDeclaration
        >();
        const localExportCandidates = new Array<ESTree.ExportSpecifier>();
        const renamedReexportCandidates = new Array<ESTree.ExportSpecifier>();

        const resolveVariable = (identifierNode) => {
          let scope: Scope | null = context.sourceCode.getScope(identifierNode);
          while (scope) {
            const variable = scope.set.get(identifierNode.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isBroadKeyTypeReference = (node): boolean => {
          if (node?.type !== "TSTypeReference") {
            return false;
          }
          if (node.typeName?.type === "Identifier") {
            const variable = resolveVariable(node.typeName);
            return variable
              ? broadKeyVariables.has(variable)
              : node.typeName.name === "TranslationKey";
          }
          return isQualifiedNamespaceMember(
            node.typeName,
            broadKeyNamespaceVariables,
            translationKeyTypeNames,
            resolveVariable,
          );
        };

        const hasTranslationKeyParameter = (node): boolean =>
          (node.params ?? []).some((parameter) =>
            isBroadKeyTypeReference(
              unwrapTypeAnnotation(parameter.typeAnnotation),
            ),
          );

        const reportBroadParameters = (node) => {
          if (hasTranslationKeyParameter(node)) {
            context.report({ messageId: "broadCallable", node });
          }
        };

        return {
          before() {
            broadTranslatorTypeNames.clear();
            broadTranslatorTypeNames.add("getTranslator");
            broadTranslatorTypeNames.add("getTranslations");
            broadTranslatorTypeNames.add("useTranslations");
            broadKeyVariables.clear();
            broadKeyNamespaceVariables.clear();
            broadTranslatorNamespaceVariables.clear();
            typeAliases.length = 0;
            broadParameterCandidates.length = 0;
            broadReturnTypeCandidates.length = 0;
            exportedAliasNodes.clear();
            localExportCandidates.length = 0;
            renamedReexportCandidates.length = 0;
          },
          Program(node) {
            for (const statement of node.body ?? []) {
              if (statement.type !== "ImportDeclaration") {
                continue;
              }
              const source = statement.source?.value;
              for (const specifier of statement.specifiers ?? []) {
                if (
                  specifier.type === "ImportNamespaceSpecifier" &&
                  specifier.local?.type === "Identifier"
                ) {
                  if (
                    typeof source === "string" &&
                    isTranslationTypeModule(source)
                  ) {
                    const variable = resolveVariable(specifier.local);
                    if (variable) {
                      broadKeyNamespaceVariables.add(variable);
                    }
                  }
                  if (
                    source === "use-intl" ||
                    (typeof source === "string" &&
                      isTranslationTypeModule(source))
                  ) {
                    const variable = resolveVariable(specifier.local);
                    if (variable) {
                      broadTranslatorNamespaceVariables.add(variable);
                    }
                  }
                  continue;
                }
                if (
                  specifier.type === "ImportSpecifier" &&
                  isIdentifierNamed(specifier.imported, "TranslationKey") &&
                  specifier.local?.type === "Identifier" &&
                  typeof source === "string" &&
                  isTranslationTypeModule(source)
                ) {
                  const variable = resolveVariable(specifier.local);
                  if (variable) {
                    broadKeyVariables.add(variable);
                  }
                }
                if (
                  specifier.type === "ImportSpecifier" &&
                  isBroadTranslatorName(specifier.imported) &&
                  specifier.local?.type === "Identifier"
                ) {
                  broadTranslatorTypeNames.add(specifier.local.name);
                }
              }
            }
          },
          "Program:exit"() {
            for (const declaration of typeAliases) {
              if (
                declaration.id?.type === "Identifier" &&
                declaration.id.name === "TranslationKey"
              ) {
                const variable = resolveVariable(declaration.id);
                if (variable) {
                  broadKeyVariables.add(variable);
                }
              }
            }

            let foundAlias = true;
            while (foundAlias) {
              foundAlias = false;
              for (const declaration of typeAliases) {
                const annotation = declaration.typeAnnotation;
                const variable = declaration.id
                  ? resolveVariable(declaration.id)
                  : null;
                if (
                  declaration.id?.type !== "Identifier" ||
                  variable === null ||
                  broadKeyVariables.has(variable) ||
                  !isBroadKeyTypeReference(annotation)
                ) {
                  continue;
                }
                broadKeyVariables.add(variable);
                foundAlias = true;
              }
            }

            for (const [declaration, exportNode] of exportedAliasNodes) {
              if (declaration.id?.name === "TranslationKey") {
                continue;
              }
              const variable = declaration.id
                ? resolveVariable(declaration.id)
                : null;
              if (variable && broadKeyVariables.has(variable)) {
                context.report({
                  messageId: "broadAliasExport",
                  node: exportNode,
                });
              }
            }
            for (const specifier of localExportCandidates) {
              if (specifier.local?.type !== "Identifier") {
                continue;
              }
              const variable = resolveVariable(specifier.local);
              if (variable && broadKeyVariables.has(variable)) {
                context.report({
                  messageId: "broadAliasExport",
                  node: specifier,
                });
              }
            }
            for (const specifier of renamedReexportCandidates) {
              context.report({
                messageId: "broadAliasExport",
                node: specifier,
              });
            }

            for (const candidate of broadParameterCandidates) {
              reportBroadParameters(candidate);
            }
            for (const candidate of broadReturnTypeCandidates) {
              if (
                !isCanonicalTranslationKeyDerivation(candidate) &&
                isBroadTranslatorReturnType(
                  candidate,
                  broadTranslatorTypeNames,
                  broadTranslatorNamespaceVariables,
                  resolveVariable,
                )
              ) {
                context.report({ messageId: "broadCallable", node: candidate });
              }
            }
          },
          TSTypeAliasDeclaration(node) {
            typeAliases.push(node);
          },
          ExportNamedDeclaration(node) {
            if (node.declaration?.type === "TSTypeAliasDeclaration") {
              exportedAliasNodes.set(node.declaration, node);
            }

            const source = node.source?.value;
            for (const specifier of node.specifiers ?? []) {
              if (
                typeof source === "string" &&
                isTranslationTypeModule(source)
              ) {
                if (
                  isIdentifierNamed(specifier.local, "TranslationKey") &&
                  !isIdentifierNamed(specifier.exported, "TranslationKey")
                ) {
                  renamedReexportCandidates.push(specifier);
                }
                continue;
              }
              if (
                (source === null || source === undefined) &&
                specifier.local?.type === "Identifier" &&
                specifier.local.name !== "TranslationKey"
              ) {
                localExportCandidates.push(specifier);
              }
            }
          },
          TSCallSignatureDeclaration(node) {
            broadParameterCandidates.push(node);
          },
          TSFunctionType(node) {
            broadParameterCandidates.push(node);
          },
          TSMethodSignature(node) {
            broadParameterCandidates.push(node);
          },
          TSTypeReference(node) {
            if (isIdentifierNamed(node.typeName, "ReturnType")) {
              broadReturnTypeCandidates.push(node);
            }
          },
        };
      },
    },
  },
});
