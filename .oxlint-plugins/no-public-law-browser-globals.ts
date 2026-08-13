import { eslintCompatPlugin } from "@oxlint/plugins";

const BROWSER_GLOBALS = new Set([
  "devicePixelRatio",
  "document",
  "history",
  "localStorage",
  "location",
  "matchMedia",
  "navigator",
  "screen",
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
    (parent?.type === "VariableDeclarator" && parent.id === node)
  );
};

const staticMemberName = (node) => {
  if (node?.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && isIdentifier(node.property)) {
    return node.property.name;
  }
  return node.computed &&
    node.property?.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : null;
};

const ambientMemberName = (node, objectName) => {
  if (
    node?.type !== "MemberExpression" ||
    !isIdentifier(node.object, objectName)
  ) {
    return null;
  }
  return staticMemberName(node);
};

const browserGlobalFromGlobalThis = (node) => {
  if (
    node?.type !== "MemberExpression" ||
    !isIdentifier(node.object, "globalThis") ||
    staticMemberName(node) === null
  ) {
    return null;
  }
  const memberName = staticMemberName(node);
  return BROWSER_GLOBALS.has(memberName) ? memberName : null;
};

const isUnshadowedGlobalThisMember = (context, node, memberName) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "globalThis") &&
  staticMemberName(node) === memberName &&
  isUnshadowedGlobal(context, node.object);

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
            if (
              browserGlobalFromGlobalThis(node) &&
              isUnshadowedGlobal(context, node.object)
            ) {
              context.report({ node, messageId: "publicLawBrowserGlobal" });
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

            const memberName = ambientMemberName(node.callee, "Date");
            const randomMemberName = ambientMemberName(node.callee, "Math");
            const performanceMemberName = ambientMemberName(
              node.callee,
              "performance",
            );
            const cryptoMemberName = ambientMemberName(node.callee, "crypto");
            const calledMemberName = staticMemberName(node.callee);
            const globalPerformanceCall =
              calledMemberName === "now" &&
              isUnshadowedGlobalThisMember(
                context,
                node.callee.object,
                "performance",
              );
            const globalCryptoCall =
              (calledMemberName === "getRandomValues" ||
                calledMemberName === "randomUUID") &&
              isUnshadowedGlobalThisMember(
                context,
                node.callee.object,
                "crypto",
              );
            if (
              (memberName === "now" &&
                isUnshadowedGlobal(context, node.callee.object)) ||
              (randomMemberName === "random" &&
                isUnshadowedGlobal(context, node.callee.object)) ||
              (performanceMemberName === "now" &&
                isUnshadowedGlobal(context, node.callee.object)) ||
              ((cryptoMemberName === "getRandomValues" ||
                cryptoMemberName === "randomUUID") &&
                isUnshadowedGlobal(context, node.callee.object)) ||
              globalPerformanceCall ||
              globalCryptoCall
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
              return;
            }

            const intlName = ambientMemberName(node.callee, "Intl");
            if (
              intlName &&
              AMBIENT_INTL_CONSTRUCTORS.has(intlName) &&
              isUnshadowedGlobal(context, node.callee.object) &&
              (node.arguments.length === 0 ||
                isIdentifier(node.arguments.at(0), "undefined"))
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

            const intlName = ambientMemberName(node.callee, "Intl");
            if (
              intlName &&
              AMBIENT_INTL_CONSTRUCTORS.has(intlName) &&
              isUnshadowedGlobal(context, node.callee.object) &&
              (node.arguments.length === 0 ||
                isIdentifier(node.arguments.at(0), "undefined"))
            ) {
              context.report({ node, messageId: "publicLawAmbientState" });
            }
          },
        };
      },
    },
  },
});
