// Keep provider response text out of provider-call error messages. The provider
// error message is consumed by persistence and retry paths, so it must remain a
// stable application-owned constant. ProviderCallError owns its fixed message;
// callers must not supply one at all.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  repoRelativeFilename,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const SOURCE_FILE = "apps/api/src/lib/tanstack-ai-generate.ts";
const FIXTURE_FILE =
  ".oxlint-plugins/__fixtures__/provider-call-error-message.fixture.ts";

const isConstantMessage = (context, value, seen = new Set()) => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (node.type === "Literal") {
    return typeof node.value === "string";
  }
  if (node.type === "TemplateLiteral") {
    return (node.expressions ?? []).length === 0;
  }
  if (!isIdentifierReference(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (
    isImportedFrom({
      context,
      node,
      modules: ["apps/api/src/lib/provider-call-error"],
      names: new Set(["PROVIDER_CALL_ERROR_MESSAGE"]),
    })
  ) {
    return true;
  }
  const variable = resolveVariable(context, node);
  if (variable === null || variable.defs.length !== 1) {
    return false;
  }
  const initializer = stableInitializer(variable);
  return initializer !== null && isConstantMessage(context, initializer, seen);
};

const providerMessageProperties = (context, value, seen = new Set()) => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return [];
  }
  seen.add(node);
  if (node.type === "ObjectExpression") {
    const found = [];
    for (const property of node.properties ?? []) {
      if (property.type === "SpreadElement") {
        for (const messageProperty of providerMessageProperties(
          context,
          property.argument,
          seen,
        )) {
          found.push(messageProperty);
        }
      } else if (
        property.type === "Property" &&
        getPropertyName(property.key) === "message"
      ) {
        found.push(property);
      }
    }
    return found;
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    const initializer = variable === null ? null : stableInitializer(variable);
    return initializer === null
      ? []
      : providerMessageProperties(context, initializer, seen);
  }
  return [];
};

const isTargetHandlerFile = (context) => {
  const filename = repoRelativeFilename(context);
  return (
    filename === SOURCE_FILE ||
    filename.endsWith(`/${SOURCE_FILE}`) ||
    filename === FIXTURE_FILE ||
    filename.endsWith(`/${FIXTURE_FILE}`)
  );
};

export default eslintCompatPlugin({
  meta: { name: "provider-call-error-message" },
  rules: {
    "provider-call-error-message": {
      meta: {
        type: "problem",
        messages: {
          dynamicHandlerMessage:
            "HandlerError in tanstack-ai-generate must use an application-owned constant message.",
          providerMessage:
            "ProviderCallError owns its fixed message; omit the `message` option.",
        },
      },
      createOnce(context) {
        return {
          NewExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (!isIdentifier(callee)) {
              return;
            }
            const isProviderCallError =
              callee.name === "ProviderCallError" ||
              isImportedFrom({
                context,
                node: callee,
                modules: ["apps/api/src/lib/provider-call-error"],
                names: new Set(["ProviderCallError"]),
              });
            const isHandlerError =
              callee.name === "HandlerError" && isTargetHandlerFile(context);
            if (!isProviderCallError && !isHandlerError) {
              return;
            }

            const options = node.arguments?.at(0);
            if (isProviderCallError) {
              for (const property of providerMessageProperties(
                context,
                options,
              )) {
                context.report({
                  node: property,
                  messageId: "providerMessage",
                });
              }
              return;
            }
            const object = unwrapExpression(options);
            if (object?.type !== "ObjectExpression") {
              return;
            }
            for (const property of object.properties ?? []) {
              if (
                property.type === "Property" &&
                getPropertyName(property.key) === "message" &&
                !isConstantMessage(context, property.value)
              ) {
                context.report({
                  node: property,
                  messageId: "dynamicHandlerMessage",
                });
              }
            }
          },
        };
      },
    },
  },
});
