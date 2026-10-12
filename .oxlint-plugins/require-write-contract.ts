import { eslintCompatPlugin } from "@oxlint/plugins";

import { SAFE_HANDLER_FACTORIES } from "../apps/api/src/lib/safe-handler-factories.ts";
import type { AstNode, ScopeContext } from "./utils.ts";
import {
  canonicalModuleId,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  repoRelativeFilename,
  resolveImport,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const FACTORY_IMPORTS = Object.entries(SAFE_HANDLER_FACTORIES).map(
  ([imported, { module, configArgument }]) => ({
    imported,
    configArgument,
    moduleId: canonicalModuleId(module, "apps/api/src/lib/api-handlers.ts"),
  }),
);

// Configs must expose their write contract to source enumeration. Resolve local
// bindings and ordered spreads; an opaque expression cannot establish a contract.
// Flagged: createSafeHandler({ description: "Replace tags", contract: "patch" }, fn)
// Accepted: createSafeHandler({ ...schema, contract: "replace", precondition }, fn)
const resolveValue = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<AstNode>(),
): AstNode | null => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (node.type === "CallExpression") {
    const factory = resolveValue(context, node.callee, seen);
    // Only a local expression-bodied factory establishes its returned config.
    // Parameter-dependent values still cannot resolve to a literal contract.
    return factory?.type === "ArrowFunctionExpression"
      ? resolveValue(context, factory.body, seen)
      : null;
  }
  if (!isIdentifierReference(node)) {
    return node;
  }
  const variable = resolveVariable(context, node);
  return variable === null
    ? null
    : resolveValue(context, stableInitializer(variable), seen);
};

const configProperty = (
  context: ScopeContext,
  value: unknown,
  key: string,
  seen = new Set<AstNode>(),
): AstNode | null | undefined => {
  const object = resolveValue(context, value);
  if (object?.type === "ConditionalExpression" && !seen.has(object)) {
    seen.add(object);
    const consequent = configProperty(
      context,
      object.consequent,
      key,
      new Set(seen),
    );
    const alternate = configProperty(
      context,
      object.alternate,
      key,
      new Set(seen),
    );
    if (consequent === undefined && alternate === undefined) {
      return undefined;
    }
    if (key === "description") {
      for (const branch of [consequent, alternate]) {
        const description = staticStringValue(branch);
        if (
          description !== null &&
          /^Replace\b/iu.test(description.trimStart())
        ) {
          return branch;
        }
      }
    }
    const text = staticStringValue(consequent);
    return text !== null && text === staticStringValue(alternate)
      ? consequent
      : null;
  }
  if (
    object?.type !== "ObjectExpression" ||
    seen.has(object) ||
    !Array.isArray(object.properties)
  ) {
    return null;
  }
  seen.add(object);
  let found: AstNode | null | undefined;
  for (const property of object.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "SpreadElement") {
      const resolved = configProperty(
        context,
        property.argument,
        key,
        new Set(seen),
      );
      // A known spread with no matching key preserves the preceding property.
      if (resolved !== undefined) {
        found = resolved;
      }
      continue;
    }
    if (
      property.type === "Property" &&
      property.computed === true &&
      !isStringLiteral(property.key)
    ) {
      found = null;
      continue;
    }
    if (property.type === "Property" && getPropertyName(property.key) === key) {
      found = resolveValue(context, property.value);
    }
  }
  return found;
};

export default eslintCompatPlugin({
  meta: { name: "require-write-contract" },
  rules: {
    "require-write-contract": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          missing:
            "Safe handler configs must declare a literal contract: patch or replace.",
          replace:
            "A handler described as Replace must declare contract: replace.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const binding = resolveImport(context, node.callee);
            if (binding === null) {
              return;
            }
            const factory = FACTORY_IMPORTS.find(
              ({ imported, moduleId }) =>
                imported === binding.imported && moduleId === binding.moduleId,
            );
            if (factory === undefined) {
              return;
            }
            const argument = node.arguments.at(0);
            const config =
              factory.configArgument === "options"
                ? configProperty(context, argument, "config")
                : argument;
            // Factory owners forward typed generic parameters unchanged. Their
            // exported factories are in the registry, so every leaf config is
            // still inspected and the compiler checks the forwarded contract.
            const filename = canonicalModuleId(
              repoRelativeFilename(context),
              "",
            );
            if (
              FACTORY_IMPORTS.some(({ moduleId }) => moduleId === filename) &&
              isIdentifierReference(config)
            ) {
              const variable = resolveVariable(context, config);
              if (
                variable?.defs.some(
                  (definition) => definition.type === "Parameter",
                )
              ) {
                return;
              }
            }
            const contract = configProperty(context, config, "contract");
            if (contract?.value !== "patch" && contract?.value !== "replace") {
              context.report({ node, messageId: "missing" });
              return;
            }
            const description = staticStringValue(
              configProperty(context, config, "description"),
            );
            if (
              contract.value === "patch" &&
              description !== null &&
              /^Replace\b/iu.test(description.trimStart())
            ) {
              context.report({ node, messageId: "replace" });
            }
          },
        };
      },
    },
  },
});
