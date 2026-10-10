// Keep provider response text out of provider-call error messages. The provider
// error message is consumed by persistence and retry paths, so it must remain a
// stable application-owned constant. ProviderCallError and ModelRunError own
// their fixed messages; callers must not supply one at all.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  repoRelativeFilename,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const SOURCE_FILE = "apps/api/src/lib/tanstack-ai-generate.ts";
const PROVIDER_CALL_ERROR_MODULE =
  "apps/api/src/lib/errors/provider-call-error";
// The errors whose constructor sets the message itself.
const FIXED_MESSAGE_ERRORS = new Set(["ProviderCallError", "ModelRunError"]);
const FIXTURE_FILE =
  ".oxlint-plugins/__fixtures__/provider-call-error-message.fixture.ts";

const isConstantMessage = (context, value, seen = new Set()) => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (staticStringValue(node) !== null) {
    return true;
  }
  if (!isIdentifierReference(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (
    isImportedFrom({
      context,
      node,
      modules: [PROVIDER_CALL_ERROR_MODULE],
      names: new Set(["PROVIDER_CALL_ERROR_MESSAGE"]),
    })
  ) {
    return true;
  }
  const variable = resolveVariable(context, node);
  if (variable?.defs.length !== 1) {
    return false;
  }
  const initializer = stableInitializer(variable);
  return isConstantMessage(context, initializer, seen);
};

const providerMessageProperties = (
  context,
  value,
  seen = new Set(),
): AstNode[] => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return [];
  }
  seen.add(node);
  if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
    const found: AstNode[] = [];
    for (const property of node.properties) {
      if (!isAstNode(property)) {
        continue;
      }
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
            "ProviderCallError and ModelRunError own their fixed message; omit the `message` option.",
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
              FIXED_MESSAGE_ERRORS.has(callee.name) ||
              isImportedFrom({
                context,
                node: callee,
                modules: [PROVIDER_CALL_ERROR_MODULE],
                names: FIXED_MESSAGE_ERRORS,
              });
            const isHandlerError =
              callee.name === "HandlerError" && isTargetHandlerFile(context);
            if (!isProviderCallError && !isHandlerError) {
              return;
            }

            const options = node.arguments.at(0);
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
            if (
              object?.type !== "ObjectExpression" ||
              !Array.isArray(object.properties)
            ) {
              return;
            }
            for (const property of object.properties) {
              if (
                isAstNode(property) &&
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
