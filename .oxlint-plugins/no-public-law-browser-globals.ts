import { eslintCompatPlugin } from "@oxlint/plugins";

import { unwrapExpression } from "./utils.ts";

const BROWSER_GLOBALS = new Set([
  "devicePixelRatio",
  "document",
  "history",
  "innerHeight",
  "innerWidth",
  "localStorage",
  "location",
  "matchMedia",
  "navigator",
  "outerHeight",
  "outerWidth",
  "pageXOffset",
  "pageYOffset",
  "screen",
  "self",
  "sessionStorage",
  "scrollX",
  "scrollY",
  "visualViewport",
  "window",
]);

const AMBIENT_INTL_CONSTRUCTORS = new Set([
  "Collator",
  "DateTimeFormat",
  "DisplayNames",
  "ListFormat",
  "NumberFormat",
  "PluralRules",
  "RelativeTimeFormat",
  "Segmenter",
]);

const AMBIENT_LOCALE_METHODS = new Set([
  "localeCompare",
  "toLocaleDateString",
  "toLocaleLowerCase",
  "toLocaleString",
  "toLocaleTimeString",
  "toLocaleUpperCase",
]);

const TIME_ZONE_SENSITIVE_LOCALE_METHODS = new Set([
  "toLocaleDateString",
  "toLocaleTimeString",
]);

const LOCAL_TIME_DATE_METHODS = new Set([
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTimezoneOffset",
  "getYear",
  "setDate",
  "setFullYear",
  "setHours",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setYear",
  "toDateString",
  "toString",
  "toTimeString",
]);

const AMBIENT_FUNCTION_MEMBERS = new Map([
  ["Date", new Set(["now", "parse"])],
  ["Math", new Set(["random"])],
  ["crypto", new Set(["getRandomValues", "randomUUID"])],
  ["performance", new Set(["now"])],
]);

const isIdentifier = (node, name) =>
  node?.type === "Identifier" && (name === undefined || node.name === name);

const isUnshadowedGlobal = (context, node) => {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.variables.find(({ name }) => name === node.name);
    if (variable) {
      return variable.defs.length === 0;
    }
    scope = scope.upper;
  }
  return true;
};

const isNonReferenceIdentifier = (node) => {
  const parent = node.parent;
  return (
    (parent?.type === "MemberExpression" &&
      parent.property === node &&
      !parent.computed) ||
    (parent?.type === "Property" &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand) ||
    ((parent?.type === "TSPropertySignature" ||
      parent?.type === "TSMethodSignature") &&
      parent.key === node &&
      !parent.computed) ||
    parent?.type === "TSTypeQuery" ||
    (parent?.type === "TSQualifiedName" && parent.right === node) ||
    (parent?.type === "VariableDeclarator" && parent.id === node) ||
    (parent?.type === "Property" &&
      parent.parent?.type === "ObjectPattern" &&
      (parent.key === node || parent.value === node))
  );
};

const isGlobalThisMemberHost = (node) => {
  let expression = node;
  let parent = expression.parent;
  while (
    parent &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "TSTypeAssertion" ||
      parent.type === "ChainExpression") &&
    parent.expression === expression
  ) {
    expression = parent;
    parent = expression.parent;
  }
  return parent?.type === "MemberExpression" && parent.object === expression;
};

const staticPatternPropertyName = (node) => {
  if (node?.type !== "Property") {
    return null;
  }
  if (!node.computed && node.key?.type === "Identifier") {
    return node.key.name;
  }
  return node.computed &&
    node.key?.type === "Literal" &&
    typeof node.key.value === "string"
    ? node.key.value
    : null;
};

const staticMemberName = (node) => {
  if (node?.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  return node.computed &&
    node.property?.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : null;
};

const ambientMemberName = (node, objectName) => {
  const object = unwrapExpression(node?.object);
  if (node?.type !== "MemberExpression" || !isIdentifier(object, objectName)) {
    return null;
  }
  return staticMemberName(node);
};

const browserGlobalFromGlobalThis = (node) => {
  const object = unwrapExpression(node?.object);
  if (
    node?.type !== "MemberExpression" ||
    !isIdentifier(object, "globalThis") ||
    staticMemberName(node) === null
  ) {
    return null;
  }
  const memberName = staticMemberName(node);
  return BROWSER_GLOBALS.has(memberName) ? memberName : null;
};

const isUnshadowedGlobalThisMember = (context, node, memberName) =>
  node?.type === "MemberExpression" &&
  isIdentifier(unwrapExpression(node.object), "globalThis") &&
  staticMemberName(node) === memberName &&
  isUnshadowedGlobal(context, unwrapExpression(node.object));

const isAmbientIntlLocale = (argument) => {
  if (argument === undefined) {
    return true;
  }
  const expression = unwrapExpression(argument);
  return (
    isIdentifier(expression, "undefined") ||
    (expression?.type === "ArrayExpression" &&
      Array.isArray(expression.elements) &&
      expression.elements.length === 0)
  );
};

const isAmbientCurrentTimeArgument = (argument) =>
  argument === undefined ||
  isIdentifier(unwrapExpression(argument), "undefined");

const localeArgumentIndex = (methodName) =>
  methodName === "localeCompare" ? 1 : 0;

const isDeterministicDateString = (value) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) ||
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(
    value,
  );

const staticTemplateText = (expression) => {
  if (
    expression?.type !== "TemplateLiteral" ||
    expression.expressions?.length !== 0 ||
    expression.quasis?.length !== 1
  ) {
    return null;
  }
  const value = expression.quasis.at(0)?.value;
  return typeof value?.cooked === "string"
    ? value.cooked
    : typeof value?.raw === "string"
      ? value.raw
      : null;
};

const isDateUtcCall = (context, node) => {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "CallExpression" &&
    ambientMemberName(unwrapExpression(expression.callee), "Date") === "UTC" &&
    isUnshadowedGlobal(
      context,
      unwrapExpression(unwrapExpression(expression.callee)?.object),
    )
  );
};

const isNumericDateInput = (node) => {
  const expression = unwrapExpression(node);
  return (
    (expression?.type === "Literal" && typeof expression.value === "number") ||
    (expression?.type === "UnaryExpression" &&
      (expression.operator === "+" || expression.operator === "-") &&
      unwrapExpression(expression.argument)?.type === "Literal" &&
      typeof unwrapExpression(expression.argument)?.value === "number")
  );
};

const hasAmbientDateConstructorArguments = (context, argumentsList) => {
  if (argumentsList.length === 0 || argumentsList.length > 1) {
    return true;
  }
  const argument = unwrapExpression(argumentsList.at(0));
  if (argument?.type === "Literal") {
    return typeof argument.value === "string"
      ? !isDeterministicDateString(argument.value)
      : !isNumericDateInput(argument);
  }
  const templateText = staticTemplateText(argument);
  if (templateText !== null) {
    return !isDeterministicDateString(templateText);
  }
  if (argument?.type === "TemplateLiteral") {
    return true;
  }
  return !(
    isDateUtcCall(context, argument) || isDateObjectReceiver(context, argument)
  );
};

const hasAmbientDateParseArguments = (argumentsList) => {
  if (argumentsList.length !== 1) {
    return true;
  }
  const argument = unwrapExpression(argumentsList.at(0));
  if (argument?.type === "Literal") {
    return (
      typeof argument.value !== "string" ||
      !isDeterministicDateString(argument.value)
    );
  }
  const templateText = staticTemplateText(argument);
  if (templateText !== null) {
    return !isDeterministicDateString(templateText);
  }
  return true;
};

const intlConstructorMemberName = (context, node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") {
    return null;
  }
  const directName = ambientMemberName(expression, "Intl");
  if (
    directName &&
    AMBIENT_INTL_CONSTRUCTORS.has(directName) &&
    isUnshadowedGlobal(context, unwrapExpression(expression.object))
  ) {
    return directName;
  }
  const globalName = staticMemberName(expression);
  return globalName &&
    AMBIENT_INTL_CONSTRUCTORS.has(globalName) &&
    isGlobalThisAmbientObject(context, expression.object, "Intl")
    ? globalName
    : null;
};

const isIntlCapabilityCall = (context, node) => {
  const callee = unwrapExpression(node?.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const methodName = staticMemberName(callee);
  if (methodName === "supportedValuesOf") {
    return isUnshadowedIntlObject(context, callee.object);
  }
  return (
    methodName === "supportedLocalesOf" &&
    intlConstructorMemberName(context, callee.object) !== null
  );
};

const isDateTimeFormatterReceiver = (context, node, visited = new Set()) => {
  const expression = unwrapExpression(node);
  if (
    (expression?.type === "CallExpression" ||
      expression?.type === "NewExpression") &&
    intlConstructorMemberName(context, expression.callee) === "DateTimeFormat"
  ) {
    return true;
  }
  if (!isIdentifier(expression, undefined)) {
    return false;
  }
  const variable = findVariable(context, expression);
  if (!variable || visited.has(variable)) {
    return false;
  }
  visited.add(variable);
  const declarator = variable.defs.find(
    ({ node: definition }) => definition?.type === "VariableDeclarator",
  )?.node;
  return (
    declarator?.type === "VariableDeclarator" &&
    isDateTimeFormatterReceiver(context, declarator.init, visited)
  );
};

const isUnshadowedIntlObject = (context, node) => {
  const expression = unwrapExpression(node);
  return (
    (isIdentifier(expression, "Intl") &&
      isUnshadowedGlobal(context, expression)) ||
    isUnshadowedGlobalThisMember(context, expression, "Intl")
  );
};

const hasExplicitTimeZone = (argument) => {
  const expression = unwrapExpression(argument);
  return (
    expression?.type === "ObjectExpression" &&
    Array.isArray(expression.properties) &&
    expression.properties.some((property) => {
      if (
        property?.type !== "Property" ||
        staticPatternPropertyName(property) !== "timeZone"
      ) {
        return false;
      }
      const value = unwrapExpression(property.value);
      return (
        value?.type === "Literal" &&
        typeof value.value === "string" &&
        value.value.length > 0
      );
    })
  );
};

const findVariable = (context, node) => {
  if (!isIdentifier(node, undefined)) {
    return null;
  }
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.variables.find(({ name }) => name === node.name);
    if (variable) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const isDateObjectReceiver = (context, node, visited = new Set()) => {
  const expression = unwrapExpression(node);
  if (expression?.type === "NewExpression") {
    const callee = unwrapExpression(expression.callee);
    return (
      (isIdentifier(callee, "Date") && isUnshadowedGlobal(context, callee)) ||
      isUnshadowedGlobalThisMember(context, callee, "Date")
    );
  }
  if (!isIdentifier(expression, undefined)) {
    return false;
  }
  const variable = findVariable(context, expression);
  if (!variable || visited.has(variable)) {
    return false;
  }
  visited.add(variable);
  const declarator = variable.defs.find(
    ({ node: definition }) => definition?.type === "VariableDeclarator",
  )?.node;
  return (
    declarator?.type === "VariableDeclarator" &&
    isDateObjectReceiver(context, declarator.init, visited)
  );
};

const isProvenPrimitiveLocaleReceiver = (
  context,
  node,
  visited = new Set(),
) => {
  const expression = unwrapExpression(node);
  if (
    expression?.type === "Literal" &&
    (typeof expression.value === "string" ||
      typeof expression.value === "number" ||
      typeof expression.value === "bigint")
  ) {
    return true;
  }
  if (
    expression?.type === "TemplateLiteral" ||
    (expression?.type === "UnaryExpression" &&
      (expression.operator === "+" || expression.operator === "-") &&
      unwrapExpression(expression.argument)?.type === "Literal" &&
      typeof unwrapExpression(expression.argument)?.value === "number")
  ) {
    return true;
  }
  if (!isIdentifier(expression, undefined)) {
    return false;
  }
  const variable = findVariable(context, expression);
  if (!variable || visited.has(variable)) {
    return false;
  }
  visited.add(variable);
  const declarator = variable.defs.find(
    ({ node: definition }) => definition?.type === "VariableDeclarator",
  )?.node;
  return (
    declarator?.type === "VariableDeclarator" &&
    isProvenPrimitiveLocaleReceiver(context, declarator.init, visited)
  );
};

const isGlobalThisAmbientObject = (context, node, memberName) =>
  isUnshadowedGlobalThisMember(context, unwrapExpression(node), memberName);

const ambientFunctionObjectName = (context, node) => {
  const expression = unwrapExpression(node);
  if (
    expression?.type === "Identifier" &&
    typeof expression.name === "string"
  ) {
    return AMBIENT_FUNCTION_MEMBERS.has(expression.name) &&
      isUnshadowedGlobal(context, expression)
      ? expression.name
      : null;
  }
  const memberName = staticMemberName(expression);
  return memberName &&
    AMBIENT_FUNCTION_MEMBERS.has(memberName) &&
    isUnshadowedGlobalThisMember(context, expression, memberName)
    ? memberName
    : null;
};

const isAmbientFunctionMember = (context, node) => {
  if (node?.type !== "MemberExpression") {
    return false;
  }
  const objectName = ambientFunctionObjectName(context, node.object);
  const memberName = staticMemberName(node);
  return (
    objectName !== null &&
    memberName !== null &&
    AMBIENT_FUNCTION_MEMBERS.get(objectName)?.has(memberName) === true
  );
};

const isDirectInvocationTarget = (node) => {
  const parent = node.parent;
  return (
    (parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
    unwrapExpression(parent.callee) === node
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-public-law-browser-globals" },
  rules: {
    "no-public-law-browser-globals": {
      meta: {
        type: "problem",
        messages: {
          publicLawBrowserGlobal:
            "Public SSR modules must not reference browser globals directly. Move the read behind a hydration-safe adapter.",
          publicLawAmbientState:
            "Public SSR output must not depend on ambient time, randomness, or locale. Inject a deterministic value or use a hydration-safe adapter.",
        },
      },
      createOnce(context) {
        return {
          Identifier(node) {
            if (
              node.name === "globalThis" &&
              !isNonReferenceIdentifier(node) &&
              !isGlobalThisMemberHost(node) &&
              isUnshadowedGlobal(context, node)
            ) {
              context.report({ node, messageId: "publicLawBrowserGlobal" });
              return;
            }
            if (
              BROWSER_GLOBALS.has(node.name) &&
              !isNonReferenceIdentifier(node) &&
              isUnshadowedGlobal(context, node)
            ) {
              context.report({ node, messageId: "publicLawBrowserGlobal" });
            }
          },
          MemberExpression(node) {
            const object = unwrapExpression(node.object);
            if (
              browserGlobalFromGlobalThis(node) &&
              isUnshadowedGlobal(context, object)
            ) {
              context.report({ node, messageId: "publicLawBrowserGlobal" });
            }
            if (
              isAmbientFunctionMember(context, node) &&
              !isDirectInvocationTarget(node)
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
            const memberName = staticMemberName(node);
            if (
              memberName &&
              AMBIENT_FUNCTION_MEMBERS.has(memberName) &&
              isUnshadowedGlobalThisMember(context, node, memberName) &&
              !(
                node.parent?.type === "MemberExpression" &&
                node.parent.object === node
              )
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
          },
          VariableDeclarator(node) {
            const initializer = unwrapExpression(node.init);
            if (node.id.type === "Identifier") {
              if (intlConstructorMemberName(context, initializer) !== null) {
                context.report({
                  node: initializer ?? node,
                  messageId: "publicLawAmbientState",
                });
              }
              if (ambientFunctionObjectName(context, initializer) !== null) {
                context.report({
                  node: initializer ?? node,
                  messageId: "publicLawAmbientState",
                });
              }
              if (
                isIdentifier(initializer, "globalThis") &&
                isUnshadowedGlobal(context, initializer)
              ) {
                context.report({
                  node: initializer ?? node,
                  messageId: "publicLawBrowserGlobal",
                });
              }
              return;
            }
            if (node.id.type !== "ObjectPattern") {
              return;
            }

            if (isUnshadowedIntlObject(context, initializer)) {
              for (const property of node.id.properties) {
                const propertyName = staticPatternPropertyName(property);
                if (
                  propertyName &&
                  AMBIENT_INTL_CONSTRUCTORS.has(propertyName)
                ) {
                  context.report({
                    node: property,
                    messageId: "publicLawAmbientState",
                  });
                }
              }
            }

            if (
              isIdentifier(initializer, "globalThis") &&
              isUnshadowedGlobal(context, initializer)
            ) {
              for (const property of node.id.properties) {
                const propertyName = staticPatternPropertyName(property);
                if (propertyName && BROWSER_GLOBALS.has(propertyName)) {
                  context.report({
                    node: property,
                    messageId: "publicLawBrowserGlobal",
                  });
                }
              }
            }

            const ambientObjectName = ambientFunctionObjectName(
              context,
              initializer,
            );
            if (ambientObjectName === null) {
              return;
            }
            const ambientMembers =
              AMBIENT_FUNCTION_MEMBERS.get(ambientObjectName);
            for (const property of node.id.properties) {
              const propertyName = staticPatternPropertyName(property);
              if (propertyName && ambientMembers?.has(propertyName)) {
                context.report({
                  node: property,
                  messageId: "publicLawAmbientState",
                });
              }
            }
          },
          AssignmentExpression(node) {
            const right = unwrapExpression(node.right);
            if (ambientFunctionObjectName(context, right) !== null) {
              context.report({
                node: right ?? node,
                messageId: "publicLawAmbientState",
              });
            }
            if (
              isIdentifier(right, "globalThis") &&
              isUnshadowedGlobal(context, right)
            ) {
              context.report({
                node: right ?? node,
                messageId: "publicLawBrowserGlobal",
              });
            }
          },
          CallExpression(node) {
            if (isIntlCapabilityCall(context, node)) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }
            if (
              isIdentifier(node.callee, "Date") &&
              isUnshadowedGlobal(context, node.callee)
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            if (node.callee.type !== "MemberExpression") {
              return;
            }

            if (isUnshadowedGlobalThisMember(context, node.callee, "Date")) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            const ambientObject = unwrapExpression(node.callee.object);
            const calledMemberName = staticMemberName(node.callee);
            if (
              (calledMemberName === "format" ||
                calledMemberName === "formatToParts") &&
              isAmbientCurrentTimeArgument(node.arguments.at(0)) &&
              isDateTimeFormatterReceiver(context, node.callee.object)
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }
            if (
              calledMemberName === "parse" &&
              ambientFunctionObjectName(context, node.callee.object) === "Date"
            ) {
              if (hasAmbientDateParseArguments(node.arguments)) {
                context.report({ node, messageId: "publicLawAmbientState" });
              }
              return;
            }
            if (isAmbientFunctionMember(context, node.callee)) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            const intlName = ambientMemberName(node.callee, "Intl");
            const globalIntlName = staticMemberName(node.callee);
            if (
              calledMemberName &&
              LOCAL_TIME_DATE_METHODS.has(calledMemberName) &&
              isDateObjectReceiver(context, node.callee.object)
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }
            if (
              calledMemberName &&
              AMBIENT_LOCALE_METHODS.has(calledMemberName) &&
              (isAmbientIntlLocale(
                node.arguments.at(localeArgumentIndex(calledMemberName)),
              ) ||
                ((TIME_ZONE_SENSITIVE_LOCALE_METHODS.has(calledMemberName) ||
                  (calledMemberName === "toLocaleString" &&
                    !isProvenPrimitiveLocaleReceiver(
                      context,
                      node.callee.object,
                    ))) &&
                  !hasExplicitTimeZone(node.arguments.at(1))))
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }
            if (
              ((intlName &&
                AMBIENT_INTL_CONSTRUCTORS.has(intlName) &&
                isUnshadowedGlobal(context, ambientObject)) ||
                (globalIntlName &&
                  AMBIENT_INTL_CONSTRUCTORS.has(globalIntlName) &&
                  isGlobalThisAmbientObject(
                    context,
                    node.callee.object,
                    "Intl",
                  ))) &&
              (isAmbientIntlLocale(node.arguments.at(0)) ||
                ((intlName === "DateTimeFormat" ||
                  globalIntlName === "DateTimeFormat") &&
                  !hasExplicitTimeZone(node.arguments.at(1))))
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
          },
          NewExpression(node) {
            if (
              isIdentifier(node.callee, "Date") &&
              isUnshadowedGlobal(context, node.callee) &&
              hasAmbientDateConstructorArguments(context, node.arguments)
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            if (node.callee.type !== "MemberExpression") {
              return;
            }

            if (
              isUnshadowedGlobalThisMember(context, node.callee, "Date") &&
              hasAmbientDateConstructorArguments(context, node.arguments)
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            const intlName = ambientMemberName(node.callee, "Intl");
            const ambientObject = unwrapExpression(node.callee.object);
            const globalIntlName = staticMemberName(node.callee);
            if (
              ((intlName &&
                AMBIENT_INTL_CONSTRUCTORS.has(intlName) &&
                isUnshadowedGlobal(context, ambientObject)) ||
                (globalIntlName &&
                  AMBIENT_INTL_CONSTRUCTORS.has(globalIntlName) &&
                  isGlobalThisAmbientObject(
                    context,
                    node.callee.object,
                    "Intl",
                  ))) &&
              (isAmbientIntlLocale(node.arguments.at(0)) ||
                ((intlName === "DateTimeFormat" ||
                  globalIntlName === "DateTimeFormat") &&
                  !hasExplicitTimeZone(node.arguments.at(1))))
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
          },
        };
      },
    },
  },
});
