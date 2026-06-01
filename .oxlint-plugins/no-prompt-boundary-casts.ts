// Disallow direct casts to chat prompt boundary brands.
//
// The brands are minted by the chat prompt assembler only. Casting
// elsewhere bypasses the stable/safe/untrusted split that stream-chat
// relies on before sending prompt text across the third-party boundary.

import { getImportedName, getPropertyName } from "./utils.ts";

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

const literalTypeValue = (
  typeAnnotation,
  namedTypeAnnotations,
  seenTypeNames = new Set(),
) => {
  if (typeAnnotation?.type !== "TSLiteralType") {
    if (typeAnnotation?.type !== "TSTypeReference") {
      return null;
    }

    const name = typeName(typeAnnotation.typeName);
    if (name === null || seenTypeNames.has(name)) {
      return null;
    }

    const namedTypeAnnotation = namedTypeAnnotations.get(name);
    if (!namedTypeAnnotation) {
      return null;
    }

    const nextSeenTypeNames = new Set(seenTypeNames);
    nextSeenTypeNames.add(name);
    return literalTypeValue(
      namedTypeAnnotationBody(namedTypeAnnotation),
      namedTypeAnnotations,
      nextSeenTypeNames,
    );
  }

  const literal = typeAnnotation.literal;
  if (literal?.type !== "Literal") {
    return null;
  }
  return literal.value;
};

const indexedAccessKeyValue = (
  typeAnnotation,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const value = literalTypeValue(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
};

const numericPropertyKeyValue = (propertyKey) => {
  if (typeof propertyKey === "number") {
    return Number.isInteger(propertyKey) ? propertyKey : null;
  }
  if (!/^-?(0|[1-9]\d*)$/.test(propertyKey)) {
    return null;
  }
  return Number(propertyKey);
};

const tupleIndexValue = (propertyKey) => {
  const index = numericPropertyKeyValue(propertyKey);
  if (index === null || index < 0) {
    return null;
  }
  return index;
};

const memberPropertyKeyValue = (node) => {
  const propertyName = getPropertyName(node);
  if (propertyName !== null) {
    return propertyName;
  }
  if (node?.type === "Literal" && typeof node.value === "number") {
    return node.value;
  }
  return null;
};

const propertyKeysMatch = (knownKey, selectedKey) =>
  knownKey === selectedKey ||
  (typeof knownKey === "number" &&
    numericPropertyKeyValue(selectedKey) === knownKey);

const unwrapIndexedAccessObjectType = (typeAnnotation) => {
  let currentTypeAnnotation = typeAnnotation;
  while (
    currentTypeAnnotation?.type === "TSParenthesizedType" ||
    (currentTypeAnnotation?.type === "TSTypeOperator" &&
      currentTypeAnnotation.operator === "readonly")
  ) {
    currentTypeAnnotation = currentTypeAnnotation.typeAnnotation;
  }
  return currentTypeAnnotation;
};

const resolvedTypeReferenceName = (
  typeAnnotation,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  let currentTypeAnnotation = typeAnnotation;
  let currentSeenTypeNames = seenTypeNames;
  while (currentTypeAnnotation?.type === "TSTypeReference") {
    const name = typeName(currentTypeAnnotation.typeName);
    if (name === null || currentSeenTypeNames.has(name)) {
      return null;
    }
    if (promptBoundaryTypeNames.has(name)) {
      return name;
    }

    const namedTypeAnnotation = namedTypeAnnotations.get(name);
    if (!namedTypeAnnotation) {
      return name;
    }

    const nextSeenTypeNames = new Set(currentSeenTypeNames);
    nextSeenTypeNames.add(name);
    currentTypeAnnotation = namedTypeAnnotationBody(namedTypeAnnotation);
    currentSeenTypeNames = nextSeenTypeNames;
  }
  return null;
};

const isStringKeywordType = (
  typeAnnotation,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  return (
    unwrapIndexedAccessObjectType(resolved.typeAnnotation)?.type ===
    "TSStringKeyword"
  );
};

const isStringLikeType = (
  typeAnnotation,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const stringType = unwrapIndexedAccessObjectType(resolved.typeAnnotation);
  const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
    namedTypeAnnotations,
    resolved.typeArgumentsByName,
  );
  if (stringType?.type === "TSStringKeyword") {
    return true;
  }
  if (
    stringType?.type === "TSLiteralType" &&
    typeof stringType.literal?.value === "string"
  ) {
    return true;
  }
  if (stringType?.type === "TSIntersectionType") {
    return stringType.types.some((typePart) =>
      isStringLikeType(
        typePart,
        scopedNamedTypeAnnotations,
        resolved.seenTypeNames,
      ),
    );
  }
  if (stringType?.type === "TSUnionType") {
    return stringType.types.every((typePart) =>
      isStringLikeType(
        typePart,
        scopedNamedTypeAnnotations,
        resolved.seenTypeNames,
      ),
    );
  }
  return false;
};

const conditionalExtendsResult = (
  checkType,
  extendsType,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const checkName = resolvedTypeReferenceName(
    checkType,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const extendsName = resolvedTypeReferenceName(
    extendsType,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  );
  if (checkName !== null && checkName === extendsName) {
    return true;
  }
  if (
    isStringLikeType(checkType, namedTypeAnnotations, seenTypeNames) &&
    isStringKeywordType(extendsType, namedTypeAnnotations, seenTypeNames)
  ) {
    return true;
  }
  if (
    checkName === null &&
    extendsName !== null &&
    isStringLikeType(checkType, namedTypeAnnotations, seenTypeNames)
  ) {
    return false;
  }
  return null;
};

const namedTypeAnnotationBody = (namedTypeAnnotation) => {
  if (namedTypeAnnotation?.type === "TSTypeAliasDeclaration") {
    return namedTypeAnnotation.typeAnnotation;
  }
  return namedTypeAnnotation;
};

const typeParameterName = (typeParameter) => {
  if (typeof typeParameter?.name === "string") {
    return typeParameter.name;
  }
  return typeName(typeParameter?.name);
};

const substituteTypeArgument = (typeArgument, typeArgumentsByName) => {
  if (typeArgument?.type !== "TSTypeReference") {
    return typeArgument;
  }

  const name = typeName(typeArgument.typeName);
  if (name === null) {
    return typeArgument;
  }

  return typeArgumentsByName.get(name) ?? typeArgument;
};

const typeArgumentsByNameForReference = (
  typeAnnotation,
  namedTypeAnnotation,
  inheritedTypeArgumentsByName = new Map(),
) => {
  const typeParameters = namedTypeAnnotation?.typeParameters?.params ?? [];
  const typeArguments = typeAnnotation.typeArguments?.params ?? [];
  if (typeParameters.length === 0) {
    return inheritedTypeArgumentsByName;
  }

  const typeArgumentsByName = new Map(inheritedTypeArgumentsByName);
  for (const [index, typeParameter] of typeParameters.entries()) {
    const name = typeParameterName(typeParameter);
    const typeArgument = typeArguments.at(index) ?? typeParameter.default;
    if (name === null || !typeArgument) {
      continue;
    }

    typeArgumentsByName.set(
      name,
      substituteTypeArgument(typeArgument, inheritedTypeArgumentsByName),
    );
  }

  return typeArgumentsByName;
};

const namedTypeAnnotationsWithTypeArguments = (
  namedTypeAnnotations,
  typeArgumentsByName,
) => {
  if (typeArgumentsByName.size === 0) {
    return namedTypeAnnotations;
  }

  const scopedNamedTypeAnnotations = new Map(namedTypeAnnotations);
  for (const [name, typeAnnotation] of typeArgumentsByName) {
    scopedNamedTypeAnnotations.set(name, typeAnnotation);
  }
  return scopedNamedTypeAnnotations;
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

const resolveNamedTypeAnnotation = (
  typeAnnotation,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  let currentTypeAnnotation = typeAnnotation;
  let currentSeenTypeNames = seenTypeNames;
  let currentTypeArgumentsByName = new Map();

  while (currentTypeAnnotation?.type === "TSTypeReference") {
    const name = typeName(currentTypeAnnotation.typeName);
    if (name === null || currentSeenTypeNames.has(name)) {
      break;
    }

    const namedTypeAnnotation = namedTypeAnnotations.get(name);
    if (!namedTypeAnnotation) {
      break;
    }

    const nextSeenTypeNames = new Set(currentSeenTypeNames);
    nextSeenTypeNames.add(name);
    currentTypeArgumentsByName = typeArgumentsByNameForReference(
      currentTypeAnnotation,
      namedTypeAnnotation,
      currentTypeArgumentsByName,
    );
    currentTypeAnnotation = namedTypeAnnotationBody(namedTypeAnnotation);
    currentSeenTypeNames = nextSeenTypeNames;
  }

  return {
    seenTypeNames: currentSeenTypeNames,
    typeArgumentsByName: currentTypeArgumentsByName,
    typeAnnotation: currentTypeAnnotation,
  };
};

const typeMembers = (typeAnnotation) => {
  if (typeAnnotation?.type === "TSTypeLiteral") {
    return typeAnnotation.members;
  }
  if (typeAnnotation?.type === "TSInterfaceBody") {
    return typeAnnotation.body;
  }
  if (typeAnnotation?.type === "TSInterfaceDeclaration") {
    return typeAnnotation.body.body;
  }
  return null;
};

const indexSignatureKeyType = (member) => {
  if (member.type !== "TSIndexSignature") {
    return null;
  }

  const parameter = member.parameters?.at(0) ?? member.params?.at(0);
  return (
    parameter?.typeAnnotation?.typeAnnotation ??
    parameter?.typeAnnotation ??
    null
  );
};

const hasPromptBoundaryNamedPropertyType = (
  typeAnnotation,
  propertyKey,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const members = typeMembers(resolved.typeAnnotation);
  const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
    namedTypeAnnotations,
    resolved.typeArgumentsByName,
  );
  if (members) {
    const member = members.find((candidate) =>
      propertyKeysMatch(memberPropertyKeyValue(candidate.key), propertyKey),
    );
    if (member) {
      return hasPromptBoundaryMemberType(
        member,
        promptBoundaryTypeNames,
        scopedNamedTypeAnnotations,
        resolved.seenTypeNames,
      );
    }
  }
  for (const member of members ?? []) {
    const keyType = indexSignatureKeyType(member);
    if (
      keyType === null ||
      !recordKeyMatchesProperty(
        keyType,
        propertyKey,
        scopedNamedTypeAnnotations,
        resolved.seenTypeNames,
      )
    ) {
      continue;
    }

    return hasPromptBoundaryMemberType(
      member,
      promptBoundaryTypeNames,
      scopedNamedTypeAnnotations,
      resolved.seenTypeNames,
    );
  }

  if (resolved.typeAnnotation?.type !== "TSInterfaceDeclaration") {
    return null;
  }

  for (const heritage of resolved.typeAnnotation.extends ?? []) {
    const name = typeName(heritage.expression);
    if (name === null || resolved.seenTypeNames.has(name)) {
      continue;
    }

    const inheritedNamedTypeAnnotation = namedTypeAnnotations.get(name);
    if (!inheritedNamedTypeAnnotation) {
      continue;
    }

    const nextSeenTypeNames = new Set(resolved.seenTypeNames);
    nextSeenTypeNames.add(name);
    const inheritedTypeArgumentsByName = typeArgumentsByNameForReference(
      heritage,
      inheritedNamedTypeAnnotation,
      resolved.typeArgumentsByName,
    );
    const inheritedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
      scopedNamedTypeAnnotations,
      inheritedTypeArgumentsByName,
    );
    const inheritedResult = hasPromptBoundaryNamedPropertyType(
      namedTypeAnnotationBody(inheritedNamedTypeAnnotation),
      propertyKey,
      promptBoundaryTypeNames,
      inheritedNamedTypeAnnotations,
      nextSeenTypeNames,
    );
    if (inheritedResult !== null) {
      return inheritedResult;
    }
  }

  return null;
};

const recordKeyMatchesProperty = (
  keyType,
  propertyKey,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  if (keyType?.type === "TSStringKeyword") {
    return true;
  }
  if (keyType?.type === "TSNumberKeyword") {
    return numericPropertyKeyValue(propertyKey) !== null;
  }

  if (keyType?.type === "TSUnionType") {
    return keyType.types.some((typePart) =>
      recordKeyMatchesProperty(
        typePart,
        propertyKey,
        namedTypeAnnotations,
        seenTypeNames,
      ),
    );
  }

  const keyValue = literalTypeValue(
    keyType,
    namedTypeAnnotations,
    seenTypeNames,
  );
  return (
    keyValue === propertyKey ||
    (typeof keyValue === "number" &&
      numericPropertyKeyValue(propertyKey) === keyValue)
  );
};

const hasPromptBoundaryRecordIndexedAccessType = (
  typeAnnotation,
  propertyKey,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
    namedTypeAnnotations,
    resolved.typeArgumentsByName,
  );
  const recordType = resolved.typeAnnotation;
  if (recordType?.type !== "TSTypeReference") {
    return null;
  }

  const name = typeName(recordType.typeName);
  if (name !== "Record") {
    return null;
  }

  const keyType = recordType.typeArguments?.params?.at(0);
  const valueType = recordType.typeArguments?.params?.at(1);
  if (
    !recordKeyMatchesProperty(
      keyType,
      propertyKey,
      scopedNamedTypeAnnotations,
      seenTypeNames,
    )
  ) {
    return false;
  }

  return hasPromptBoundaryType(
    valueType,
    promptBoundaryTypeNames,
    scopedNamedTypeAnnotations,
    resolved.seenTypeNames,
  );
};

const hasPromptBoundaryObjectIndexedAccessType = (
  typeAnnotation,
  propertyKey,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const objectType = unwrapIndexedAccessObjectType(resolved.typeAnnotation);
  const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
    namedTypeAnnotations,
    resolved.typeArgumentsByName,
  );
  if (
    objectType?.type === "TSUnionType" ||
    objectType?.type === "TSIntersectionType"
  ) {
    let hasKnownProperty = false;
    for (const typePart of objectType.types) {
      const typePartResult = hasPromptBoundaryObjectIndexedAccessType(
        typePart,
        propertyKey,
        promptBoundaryTypeNames,
        scopedNamedTypeAnnotations,
        resolved.seenTypeNames,
      );
      if (typePartResult === true) {
        return true;
      }
      if (typePartResult === false) {
        hasKnownProperty = true;
      }
    }
    return hasKnownProperty ? false : null;
  }

  const namedPropertyResult = hasPromptBoundaryNamedPropertyType(
    objectType,
    propertyKey,
    promptBoundaryTypeNames,
    scopedNamedTypeAnnotations,
    resolved.seenTypeNames,
  );
  if (namedPropertyResult !== null) {
    return namedPropertyResult;
  }

  return hasPromptBoundaryRecordIndexedAccessType(
    objectType,
    propertyKey,
    promptBoundaryTypeNames,
    scopedNamedTypeAnnotations,
    resolved.seenTypeNames,
  );
};

const hasPromptBoundaryArrayIndexedAccessType = (
  typeAnnotation,
  index,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  if (!Number.isInteger(index) || index < 0) {
    return false;
  }

  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const arrayType = unwrapIndexedAccessObjectType(resolved.typeAnnotation);
  const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
    namedTypeAnnotations,
    resolved.typeArgumentsByName,
  );
  if (arrayType?.type === "TSArrayType") {
    return hasPromptBoundaryType(
      arrayType.elementType,
      promptBoundaryTypeNames,
      scopedNamedTypeAnnotations,
      resolved.seenTypeNames,
    );
  }

  if (arrayType?.type !== "TSTypeReference") {
    return null;
  }

  const name = typeName(arrayType.typeName);
  if (name !== "Array" && name !== "ReadonlyArray") {
    return null;
  }

  return hasPromptBoundaryType(
    arrayType.typeArguments?.params?.at(0),
    promptBoundaryTypeNames,
    scopedNamedTypeAnnotations,
    resolved.seenTypeNames,
  );
};

const hasPromptBoundaryTupleIndexedAccessType = (
  typeAnnotation,
  index,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const resolved = resolveNamedTypeAnnotation(
    typeAnnotation,
    namedTypeAnnotations,
    seenTypeNames,
  );
  const tupleType = unwrapIndexedAccessObjectType(resolved.typeAnnotation);
  if (tupleType?.type !== "TSTupleType") {
    return null;
  }

  if (!Number.isInteger(index) || index < 0) {
    return false;
  }

  const elementType = tupleType.elementTypes[index];
  if (!elementType) {
    return false;
  }

  const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
    namedTypeAnnotations,
    resolved.typeArgumentsByName,
  );
  return hasPromptBoundaryType(
    elementType,
    promptBoundaryTypeNames,
    scopedNamedTypeAnnotations,
    resolved.seenTypeNames,
  );
};

const hasPromptBoundaryIndexedAccessType = (
  typeAnnotation,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const propertyKey = indexedAccessKeyValue(
    typeAnnotation.indexType,
    namedTypeAnnotations,
    seenTypeNames,
  );
  if (propertyKey === null) {
    return null;
  }

  const tupleIndex = tupleIndexValue(propertyKey);
  if (tupleIndex !== null) {
    const tupleResult = hasPromptBoundaryTupleIndexedAccessType(
      typeAnnotation.objectType,
      tupleIndex,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
    if (tupleResult !== null) {
      return tupleResult;
    }

    const arrayResult = hasPromptBoundaryArrayIndexedAccessType(
      typeAnnotation.objectType,
      tupleIndex,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
    if (arrayResult !== null) {
      return arrayResult;
    }
  }

  return (
    hasPromptBoundaryObjectIndexedAccessType(
      typeAnnotation.objectType,
      propertyKey,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    ) ?? false
  );
};

const hasPromptBoundaryConditionalType = (
  typeAnnotation,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
  const extendsResult = conditionalExtendsResult(
    typeAnnotation.checkType,
    typeAnnotation.extendsType,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
  );
  if (extendsResult !== null) {
    return hasPromptBoundaryType(
      extendsResult ? typeAnnotation.trueType : typeAnnotation.falseType,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
  }

  return [typeAnnotation.trueType, typeAnnotation.falseType].some((typePart) =>
    hasPromptBoundaryType(
      typePart,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    ),
  );
};

const hasPromptBoundaryTypeArguments = (
  typeArguments,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) =>
  typeArguments?.params?.some((param) =>
    hasPromptBoundaryType(
      param,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    ),
  ) === true;

const hasPromptBoundaryTypeReference = (
  typeAnnotation,
  promptBoundaryTypeNames,
  namedTypeAnnotations,
  seenTypeNames,
) => {
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
    const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
      namedTypeAnnotations,
      typeArgumentsByNameForReference(typeAnnotation, namedAnnotation),
    );
    if (
      hasPromptBoundaryType(
        namedTypeAnnotationBody(namedAnnotation),
        promptBoundaryTypeNames,
        scopedNamedTypeAnnotations,
        nextSeenTypeNames,
      )
    ) {
      return true;
    }
    return false;
  }

  return hasPromptBoundaryTypeArguments(
    typeAnnotation.typeArguments,
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
    const scopedNamedTypeAnnotations = namedTypeAnnotationsWithTypeArguments(
      namedTypeAnnotations,
      typeArgumentsByNameForReference(heritage, inheritedAnnotation),
    );
    if (
      hasPromptBoundaryType(
        namedTypeAnnotationBody(inheritedAnnotation),
        promptBoundaryTypeNames,
        scopedNamedTypeAnnotations,
        nextSeenTypeNames,
      )
    ) {
      return true;
    }
  }

  return hasPromptBoundaryTypeArguments(
    heritage.typeArguments,
    promptBoundaryTypeNames,
    namedTypeAnnotations,
    seenTypeNames,
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
    return hasPromptBoundaryTypeReference(
      typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
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

  if (typeAnnotation.type === "TSNamedTupleMember") {
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
    const indexedAccessResult = hasPromptBoundaryIndexedAccessType(
      typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
    if (indexedAccessResult !== null) {
      return indexedAccessResult;
    }

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

  if (typeAnnotation.type === "TSConditionalType") {
    return hasPromptBoundaryConditionalType(
      typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
    );
  }

  if (typeAnnotation.type === "TSMappedType") {
    return hasPromptBoundaryType(
      typeAnnotation.typeAnnotation,
      promptBoundaryTypeNames,
      namedTypeAnnotations,
      seenTypeNames,
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
            namedTypeAnnotations.set(node.id.name, node);
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
