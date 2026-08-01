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

const unwrapTypeAnnotation = (node) =>
  node?.type === "TSTypeAnnotation" ? node.typeAnnotation : node;

const hasTranslationKeyParameter = (
  node,
  broadKeyTypeNames: Set<string>,
): boolean =>
  (node.params ?? []).some((parameter) => {
    const annotation = unwrapTypeAnnotation(parameter.typeAnnotation);
    return (
      annotation?.type === "TSTypeReference" &&
      annotation.typeName?.type === "Identifier" &&
      broadKeyTypeNames.has(annotation.typeName.name)
    );
  });

const isBroadTranslatorReturnType = (node): boolean => {
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
    (isIdentifierNamed(queriedType.exprName, "getTranslator") ||
      isIdentifierNamed(queriedType.exprName, "useTranslations"))
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

        const reportBroadParameters = (node) => {
          if (hasTranslationKeyParameter(node, broadKeyTypeNames)) {
            context.report({ messageId: "broadCallable", node });
          }
        };

        return {
          Program(node) {
            for (const statement of node.body ?? []) {
              if (statement.type !== "ImportDeclaration") {
                continue;
              }
              for (const specifier of statement.specifiers ?? []) {
                if (
                  specifier.type === "ImportSpecifier" &&
                  isIdentifierNamed(specifier.imported, "TranslationKey") &&
                  specifier.local?.type === "Identifier"
                ) {
                  broadKeyTypeNames.add(specifier.local.name);
                }
              }
            }

            let foundAlias = true;
            while (foundAlias) {
              foundAlias = false;
              for (const statement of node.body ?? []) {
                if (statement.type !== "TSTypeAliasDeclaration") {
                  continue;
                }
                const annotation = statement.typeAnnotation;
                if (
                  statement.id?.type !== "Identifier" ||
                  broadKeyTypeNames.has(statement.id.name) ||
                  annotation?.type !== "TSTypeReference" ||
                  annotation.typeName?.type !== "Identifier" ||
                  !broadKeyTypeNames.has(annotation.typeName.name)
                ) {
                  continue;
                }
                broadKeyTypeNames.add(statement.id.name);
                foundAlias = true;
              }
            }
          },
          TSCallSignatureDeclaration: reportBroadParameters,
          TSFunctionType: reportBroadParameters,
          TSTypeReference(node) {
            if (isBroadTranslatorReturnType(node)) {
              context.report({ messageId: "broadCallable", node });
            }
          },
        };
      },
    },
  },
};
