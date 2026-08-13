import { eslintCompatPlugin } from "@oxlint/plugins";

import { unwrapExpression } from "./utils.ts";

const BROWSER_GLOBALS = new Set([
  "devicePixelRatio",
  "document",
  "history",
  "localStorage",
  "location",
  "matchMedia",
  "navigator",
  "screen",
  "self",
  "sessionStorage",
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
    (parent?.type === "TSQualifiedName" && parent.right === node) ||
    (parent?.type === "VariableDeclarator" && parent.id === node) ||
    (parent?.type === "Property" &&
      parent.parent?.type === "ObjectPattern" &&
      (parent.key === node || parent.value === node))
  );
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

const isGlobalThisAmbientObject = (context, node, memberName) =>
  isUnshadowedGlobalThisMember(context, unwrapExpression(node), memberName);

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
          },
          VariableDeclarator(node) {
            const initializer = unwrapExpression(node.init);
            if (
              node.id?.type !== "ObjectPattern" ||
              !isIdentifier(initializer, "globalThis") ||
              !isUnshadowedGlobal(context, initializer)
            ) {
              return;
            }

            for (const property of node.id.properties) {
              const propertyName = staticPatternPropertyName(property);
              if (propertyName && BROWSER_GLOBALS.has(propertyName)) {
                context.report({
                  node: property,
                  messageId: "publicLawBrowserGlobal",
                });
              }
            }
          },
          CallExpression(node) {
            if (
              isIdentifier(node.callee, "Date") &&
              isUnshadowedGlobal(context, node.callee) &&
              node.arguments.length === 0
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            if (node.callee.type !== "MemberExpression") {
              return;
            }

            if (
              isUnshadowedGlobalThisMember(context, node.callee, "Date") &&
              node.arguments.length === 0
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            const memberName = ambientMemberName(node.callee, "Date");
            const randomMemberName = ambientMemberName(node.callee, "Math");
            const performanceMemberName = ambientMemberName(
              node.callee,
              "performance",
            );
            const cryptoMemberName = ambientMemberName(node.callee, "crypto");
            const ambientObject = unwrapExpression(node.callee.object);
            const calledMemberName = staticMemberName(node.callee);
            const globalPerformanceCall =
              calledMemberName === "now" &&
              isGlobalThisAmbientObject(
                context,
                node.callee.object,
                "performance",
              );
            const globalCryptoCall =
              (calledMemberName === "getRandomValues" ||
                calledMemberName === "randomUUID") &&
              isGlobalThisAmbientObject(context, node.callee.object, "crypto");
            const globalDateCall =
              calledMemberName === "now" &&
              isGlobalThisAmbientObject(context, node.callee.object, "Date");
            const globalMathCall =
              calledMemberName === "random" &&
              isGlobalThisAmbientObject(context, node.callee.object, "Math");
            if (
              (memberName === "now" &&
                isUnshadowedGlobal(context, ambientObject)) ||
              (randomMemberName === "random" &&
                isUnshadowedGlobal(context, ambientObject)) ||
              (performanceMemberName === "now" &&
                isUnshadowedGlobal(context, ambientObject)) ||
              ((cryptoMemberName === "getRandomValues" ||
                cryptoMemberName === "randomUUID") &&
                isUnshadowedGlobal(context, ambientObject)) ||
              globalPerformanceCall ||
              globalCryptoCall ||
              globalDateCall ||
              globalMathCall
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            const intlName = ambientMemberName(node.callee, "Intl");
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
              isAmbientIntlLocale(node.arguments.at(0))
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
          },
          NewExpression(node) {
            if (
              isIdentifier(node.callee, "Date") &&
              isUnshadowedGlobal(context, node.callee) &&
              node.arguments.length === 0
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            if (node.callee.type !== "MemberExpression") {
              return;
            }

            if (
              isUnshadowedGlobalThisMember(context, node.callee, "Date") &&
              node.arguments.length === 0
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
              isAmbientIntlLocale(node.arguments.at(0))
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
          },
        };
      },
    },
  },
});
