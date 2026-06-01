// Disallow direct casts to chat prompt boundary brands.
//
// The brands are minted by the chat prompt assembler only. Casting
// elsewhere bypasses the stable/safe/untrusted split that stream-chat
// relies on before sending prompt text across the third-party boundary.

import { getImportedName } from "./utils.ts";

const PROMPT_BOUNDARY_TYPES = new Set([
  "ChatCacheStablePrefix",
  "ChatSafePrompt",
  "ChatUntrustedPromptSuffix",
  "ChatFullPrompt",
]);

const ALLOWED_FILE = "apps/api/src/handlers/chat/chat-prompt.ts";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context) =>
  filenameForContext(context).replaceAll("\\", "/").endsWith(ALLOWED_FILE);

const typeName = (node) => {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "TSQualifiedName") {
    return typeName(node.right);
  }
  return null;
};

const hasPromptBoundaryParamType = (
  param,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) =>
  hasPromptBoundaryType(
    param.typeAnnotation?.typeAnnotation,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  ) ||
  hasPromptBoundaryType(
    param.argument?.typeAnnotation?.typeAnnotation,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  );

const hasPromptBoundaryFunctionType = (
  typeAnnotation,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) =>
  hasPromptBoundaryType(
    typeAnnotation.returnType?.typeAnnotation,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  ) ||
  typeAnnotation.params?.some((param) =>
    hasPromptBoundaryParamType(
      param,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    ),
  ) === true;

const hasPromptBoundaryMemberType = (
  member,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  if (
    hasPromptBoundaryType(
      member.typeAnnotation?.typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    )
  ) {
    return true;
  }

  if (
    member.type !== "TSCallSignatureDeclaration" &&
    member.type !== "TSConstructSignatureDeclaration" &&
    member.type !== "TSMethodSignature"
  ) {
    return false;
  }

  return hasPromptBoundaryFunctionType(
    member,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  );
};

const hasPromptBoundaryInterfaceHeritage = (
  heritage,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const name = typeName(heritage.expression);
  if (name !== null && promptBoundaryTypeNames.has(name)) {
    return true;
  }

  const inheritedAnnotation =
    name !== null && !seenTypeNames.has(name)
      ? namedTypeAnnotations.get(name)
      : null;
  if (inheritedAnnotation) {
    const nextSeenTypeNames = new Set(seenTypeNames);
    nextSeenTypeNames.add(name);
    if (
      hasPromptBoundaryType(
        inheritedAnnotation,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        nextSeenTypeNames,
      )
    ) {
      return true;
    }
  }

  return (
    heritage.typeArguments?.params?.some((param) =>
      hasPromptBoundaryType(
        param,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      ),
    ) === true
  );
};

const hasPromptBoundaryType = (
  typeAnnotation,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames = new Set(),
) => {
  if (!typeAnnotation) {
    return false;
  }

  if (typeAnnotation.type === "TSTypeReference") {
    const name = typeName(typeAnnotation.typeName);
    if (name !== null && promptBoundaryTypeNames.has(name)) {
      return true;
    }
    const namedAnnotation =
      name !== null && !seenTypeNames.has(name)
        ? namedTypeAnnotations.get(name)
        : null;
    if (namedAnnotation) {
      const nextSeenTypeNames = new Set(seenTypeNames);
      nextSeenTypeNames.add(name);
      if (
        hasPromptBoundaryType(
          namedAnnotation,
          promptBoundaryTypeNames,
          namedTypeAnnotations,
          nextSeenTypeNames,
        )
      ) {
        return true;
      }
    }

    return (
      typeAnnotation.typeArguments?.params?.some((param) =>
        hasPromptBoundaryType(
          param,
          promptBoundaryTypeNames,
          namedTypeAnnotations,
          seenTypeNames,
        ),
      ) === true
    );
  }

  if (typeAnnotation.type === "TSImportType") {
    const name = typeName(typeAnnotation.qualifier);
    return (
      (name !== null && promptBoundaryTypeNames.has(name)) ||
      typeAnnotation.typeArguments?.params?.some((param) =>
        hasPromptBoundaryType(
          param,
          promptBoundaryTypeNames,
          namedTypeAnnotations,
          seenTypeNames,
        ),
      ) === true
    );
  }

  if (typeAnnotation.type === "TSArrayType") {
    return hasPromptBoundaryType(
      typeAnnotation.elementType,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
  }

  if (typeAnnotation.type === "TSTupleType") {
    return typeAnnotation.elementTypes.some((elementType) =>
      hasPromptBoundaryType(
        elementType,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      ),
    );
  }

  if (typeAnnotation.type === "TSIndexedAccessType") {
    return (
      hasPromptBoundaryType(
        typeAnnotation.objectType,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      ) ||
      hasPromptBoundaryType(
        typeAnnotation.indexType,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      )
    );
  }

  if (typeAnnotation.type === "TSTypeLiteral") {
    return typeAnnotation.members.some((member) =>
      hasPromptBoundaryMemberType(
        member,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      ),
    );
  }

  if (typeAnnotation.type === "TSInterfaceBody") {
    return typeAnnotation.body.some((member) =>
      hasPromptBoundaryMemberType(
        member,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      ),
    );
  }

  if (typeAnnotation.type === "TSInterfaceDeclaration") {
    if (
      typeAnnotation.extends?.some((heritage) =>
        hasPromptBoundaryInterfaceHeritage(
          heritage,
          promptBoundaryTypeNames,
          namedTypeAnnotations,
          seenTypeNames,
        ),
      ) === true
    ) {
      return true;
    }

    return hasPromptBoundaryType(
      typeAnnotation.body,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
  }

  if (
    typeAnnotation.type === "TSOptionalType" ||
    typeAnnotation.type === "TSRestType" ||
    typeAnnotation.type === "TSParenthesizedType" ||
    typeAnnotation.type === "TSTypeOperator"
  ) {
    return hasPromptBoundaryType(
      typeAnnotation.typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
  }

  if (
    typeAnnotation.type === "TSUnionType" ||
    typeAnnotation.type === "TSIntersectionType"
  ) {
    return typeAnnotation.types.some((type) =>
      hasPromptBoundaryType(
        type,
        promptBoundaryTypeNames,
        namedTypeAnnotations,
        seenTypeNames,
      ),
    );
  }

  if (
    typeAnnotation.type === "TSConstructorType" ||
    typeAnnotation.type === "TSFunctionType"
  ) {
    return hasPromptBoundaryFunctionType(
      typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
  }

  return false;
};

export default {
  meta: { name: "no-prompt-boundary-casts" },
  rules: {
    "no-prompt-boundary-casts": {
      meta: {
        type: "problem",
        messages: {
          noPromptBoundaryCast:
            "Do not cast to chat prompt boundary brands outside chat-prompt.ts. " +
            "Return branded values from the prompt assembler instead.",
        },
      },
      create(context) {
        if (isAllowedFile(context)) {
          return {};
        }
        const promptBoundaryTypeNames = new Set(PROMPT_BOUNDARY_TYPES);
        const namedTypeAnnotations = new Map();
        const assertionNodes = [];

        function check(node) {
          if (
            !hasPromptBoundaryType(
              node.typeAnnotation,
              promptBoundaryTypeNames,
              namedTypeAnnotations,
            )
          ) {
            return;
          }

          context.report({ node, messageId: "noPromptBoundaryCast" });
        }

        return {
          ImportDeclaration(node) {
            for (const specifier of node.specifiers) {
              if (specifier.type !== "ImportSpecifier") {
                continue;
              }
              const importedName = getImportedName(specifier);
              if (
                importedName !== null &&
                PROMPT_BOUNDARY_TYPES.has(importedName)
              ) {
                promptBoundaryTypeNames.add(specifier.local.name);
              }
            }
          },
          TSTypeAliasDeclaration(node) {
            namedTypeAnnotations.set(node.id.name, node.typeAnnotation);
          },
          TSInterfaceDeclaration(node) {
            namedTypeAnnotations.set(node.id.name, node);
          },
          TSAsExpression(node) {
            assertionNodes.push(node);
          },
          TSTypeAssertion(node) {
            assertionNodes.push(node);
          },
          "Program:exit"() {
            for (const node of assertionNodes) {
              check(node);
            }
          },
        };
      },
    },
  },
};
