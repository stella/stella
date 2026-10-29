// Public invoice-link routes must finish through the delivery owner. This is
// a syntactic bypass guard; it does not prove arbitrary alias/data flow.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, isIdentifier, isStringLiteral } from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "require-invoice-link-delivery-gate";
const API_HANDLERS = "@/api/lib/api-handlers";
const DELIVERY_OWNER = "@/api/handlers/invoice-links/delivery";

const importNames = (node: AstNode, source: string) => {
  const names = new Map<string, string>();
  if (!isStringLiteral(node.source) || node.source.value !== source) {
    return names;
  }
  if (!Array.isArray(node.specifiers)) {
    return names;
  }
  for (const specifier of node.specifiers) {
    if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
      continue;
    }
    const imported = isIdentifier(specifier.imported)
      ? specifier.imported.name
      : isStringLiteral(specifier.imported)
        ? specifier.imported.value
        : "";
    if (imported && isIdentifier(specifier.local)) {
      names.set(imported, specifier.local.name);
    }
  }
  return names;
};

const isMemberCall = (
  node: unknown,
  objectName: string,
  propertyName: string,
) => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !isAstNode(node.callee) ||
    node.callee.type !== "MemberExpression" ||
    !isIdentifier(node.callee.object, objectName)
  ) {
    return false;
  }
  if (!node.callee.computed) {
    return isIdentifier(node.callee.property, propertyName);
  }
  return (
    isStringLiteral(node.callee.property) &&
    node.callee.property.value === propertyName
  );
};

const isAsyncOrGeneratorFunction = (node: unknown) =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression") &&
  (node.async === true || node.generator === true);

const responseCallbackProperty = (node: unknown) => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !Array.isArray(node.arguments)
  ) {
    return undefined;
  }
  const options = node.arguments.at(0);
  if (
    !isAstNode(options) ||
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return undefined;
  }
  for (const property of options.properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      !isAstNode(property.key) ||
      !(
        (property.computed === false &&
          isIdentifier(property.key, "response")) ||
        (property.computed === false &&
          isStringLiteral(property.key) &&
          property.key.value === "response")
      )
    ) {
      continue;
    }
    if (isAsyncOrGeneratorFunction(property.value)) {
      return property;
    }
  }
  return undefined;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directSuccess:
            "Public invoice-link handlers must return success through deliverInvoiceLink, not construct Result.ok directly.",
          missingDelivery:
            "Import and call deliverInvoiceLink from the invoice-link delivery owner before returning the public response.",
          asyncResponse:
            "The invoice-link response callback must be synchronous so response construction finishes before delivery completes.",
        },
      },
      createOnce(context) {
        const resultNames = new Set<string>();
        const deliveryNames = new Set<string>();
        const directSuccesses: AstNode[] = [];
        let hasDeliveryCall = false;
        let hasSafeHandlerImport = false;
        return {
          Program() {
            resultNames.clear();
            deliveryNames.clear();
            directSuccesses.length = 0;
            hasDeliveryCall = false;
            hasSafeHandlerImport = false;
          },
          ImportDeclaration(node) {
            const source = isStringLiteral(node.source)
              ? node.source.value
              : "";
            if (source === API_HANDLERS) {
              const names = importNames(node, API_HANDLERS);
              hasSafeHandlerImport ||= names.has("createSafeTokenHandler");
            }
            if (source === "better-result") {
              const names = importNames(node, source);
              const local = names.get("Result");
              if (local) {
                resultNames.add(local);
              }
            }
            if (source === DELIVERY_OWNER) {
              const names = importNames(node, source);
              const local = names.get("deliverInvoiceLink");
              if (local) {
                deliveryNames.add(local);
              }
            }
          },
          CallExpression(node) {
            if (!isAstNode(node) || !isAstNode(node.callee)) {
              return;
            }
            if (
              node.callee.type === "Identifier" &&
              deliveryNames.has(node.callee.name)
            ) {
              hasDeliveryCall = true;
              const property = responseCallbackProperty(node);
              if (property) {
                context.report({ node: property, messageId: "asyncResponse" });
              }
            }
            for (const resultName of resultNames) {
              if (isMemberCall(node, resultName, "ok")) {
                directSuccesses.push(node);
              }
            }
          },
          "Program:exit"(node) {
            if (!hasSafeHandlerImport) {
              return;
            }
            for (const success of directSuccesses) {
              context.report({ node: success, messageId: "directSuccess" });
            }
            if (hasSafeHandlerImport && !hasDeliveryCall) {
              context.report({ node, messageId: "missingDelivery" });
            }
          },
        };
      },
    },
  },
});
