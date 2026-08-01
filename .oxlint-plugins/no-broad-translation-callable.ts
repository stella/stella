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

const isIdentifierNamed = (node, name: string): boolean =>
  node?.type === "Identifier" && node.name === name;

const isBroadTranslatorName = (node): boolean =>
  isIdentifierNamed(node, "getTranslator") ||
  isIdentifierNamed(node, "useTranslations");

const isTranslationTypeModule = (source: string): boolean =>
  source.endsWith("/i18n/types") || source.endsWith("/i18n/utils");

const translationKeyTypeNames = new Set(["TranslationKey"]);
const broadTranslatorMemberNames = new Set([
  "getTranslator",
  "useTranslations",
]);

const unwrapTypeAnnotation = (node) =>
  node?.type === "TSTypeAnnotation" ? node.typeAnnotation : node;

const unwrapExportedDeclaration = (node) =>
  node?.type === "ExportNamedDeclaration" ? node.declaration : node;

const qualifiedNameRoot = (node): string | null => {
  if (node?.type === "Identifier") {
    return node.name;
  }
  if (node?.type === "TSQualifiedName") {
    return qualifiedNameRoot(node.left);
  }
  return null;
};

const isQualifiedNamespaceMember = (
  node,
  namespaces: Set<string>,
  memberNames: Set<string>,
): boolean => {
  const root = qualifiedNameRoot(node);
  return (
    node?.type === "TSQualifiedName" &&
    node.right?.type === "Identifier" &&
    memberNames.has(node.right.name) &&
    root !== null &&
    namespaces.has(root)
  );
};

const isBroadKeyTypeReference = (
  node,
  broadKeyTypeNames: Set<string>,
  broadKeyTypeNamespaces: Set<string>,
): boolean =>
  node?.type === "TSTypeReference" &&
  (node.typeName?.type === "Identifier" &&
  broadKeyTypeNames.has(node.typeName.name)
    ? true
    : isQualifiedNamespaceMember(
        node.typeName,
        broadKeyTypeNamespaces,
        translationKeyTypeNames,
      ));

const hasTranslationKeyParameter = (
  node,
  broadKeyTypeNames: Set<string>,
  broadKeyTypeNamespaces: Set<string>,
): boolean =>
  (node.params ?? []).some((parameter) => {
    const annotation = unwrapTypeAnnotation(parameter.typeAnnotation);
    return isBroadKeyTypeReference(
      annotation,
      broadKeyTypeNames,
      broadKeyTypeNamespaces,
    );
  });

const isBroadTranslatorReturnType = (
  node,
  broadTranslatorTypeNames: Set<string>,
  broadTranslatorNamespaces: Set<string>,
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
        broadTranslatorNamespaces,
        broadTranslatorMemberNames,
      ))
  );
};

export default {
  meta: { name: "no-broad-translation-callable" },
  rules: {
    "no-broad-translation-callable": {
      meta: {
        type: "problem",
        messages: {
          broadCallable:
            "Do not pass the full use-intl translator across a helper boundary; translate fixed keys at the UI call site, pass plain strings, or expose a narrow key union.",
        },
      },
      create(context) {
        const broadKeyTypeNames = new Set(["TranslationKey"]);
        const broadTranslatorTypeNames = new Set([
          "getTranslator",
          "useTranslations",
        ]);
        const broadKeyTypeNamespaces = new Set<string>();
        const broadTranslatorNamespaces = new Set<string>();

        const reportBroadParameters = (node) => {
          if (
            hasTranslationKeyParameter(
              node,
              broadKeyTypeNames,
              broadKeyTypeNamespaces,
            )
          ) {
            context.report({ messageId: "broadCallable", node });
          }
        };

        return {
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
                    broadKeyTypeNamespaces.add(specifier.local.name);
                  }
                  if (source === "use-intl") {
                    broadTranslatorNamespaces.add(specifier.local.name);
                  }
                  continue;
                }
                if (
                  specifier.type === "ImportSpecifier" &&
                  isIdentifierNamed(specifier.imported, "TranslationKey") &&
                  specifier.local?.type === "Identifier"
                ) {
                  broadKeyTypeNames.add(specifier.local.name);
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

            let foundAlias = true;
            while (foundAlias) {
              foundAlias = false;
              for (const statement of node.body ?? []) {
                const declaration = unwrapExportedDeclaration(statement);
                if (declaration?.type !== "TSTypeAliasDeclaration") {
                  continue;
                }
                const annotation = declaration.typeAnnotation;
                if (
                  declaration.id?.type !== "Identifier" ||
                  broadKeyTypeNames.has(declaration.id.name) ||
                  !isBroadKeyTypeReference(
                    annotation,
                    broadKeyTypeNames,
                    broadKeyTypeNamespaces,
                  )
                ) {
                  continue;
                }
                broadKeyTypeNames.add(declaration.id.name);
                foundAlias = true;
              }
            }
          },
          TSCallSignatureDeclaration: reportBroadParameters,
          TSFunctionType: reportBroadParameters,
          TSMethodSignature: reportBroadParameters,
          TSTypeReference(node) {
            if (
              isBroadTranslatorReturnType(
                node,
                broadTranslatorTypeNames,
                broadTranslatorNamespaces,
              )
            ) {
              context.report({ messageId: "broadCallable", node });
            }
          },
        };
      },
    },
  },
};
