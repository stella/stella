import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isFileIn,
  isIdentifierReference,
  resolveImportedExpression,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
  type ScopeContext,
} from "./utils.ts";

const TOAST_MODULES = new Set(["@stll/ui/toast", "@stll/ui/components/toast"]);
const OWNERS = ["apps/web/src/lib/errors/user-toast.ts"];

const toastMethod = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (node.type === "MemberExpression") {
    const binding = resolveImportedExpression(context, node.object);
    if (
      binding !== null &&
      TOAST_MODULES.has(binding.source) &&
      binding.imported === "stellaToast"
    ) {
      return node.computed
        ? (staticStringValue(node.property) ?? "dynamic")
        : getPropertyName(node.property);
    }
    return null;
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  if (variable === null) {
    return null;
  }
  const initializer = stableInitializer(variable);
  const definition = variable.defs.at(0);
  if (initializer === null || definition === undefined) {
    return null;
  }
  const declarator: unknown = definition.node;
  if (
    isAstNode(declarator) &&
    isAstNode(declarator.id) &&
    declarator.id.type === "ObjectPattern"
  ) {
    const binding = resolveImportedExpression(context, initializer);
    if (
      binding === null ||
      !TOAST_MODULES.has(binding.source) ||
      binding.imported !== "stellaToast"
    ) {
      return null;
    }
    const properties = Array.isArray(declarator.id.properties)
      ? declarator.id.properties
      : [];
    for (const property of properties) {
      if (
        isAstNode(property) &&
        isIdentifierReference(property.value) &&
        property.value.name === node.name
      ) {
        return getPropertyName(property.key);
      }
    }
    return null;
  }
  return toastMethod(context, initializer, seen);
};

// A dynamic discriminator can select an error branch; require locally
// provable non-error values outside the shared owner.
const mayBeErrorDiscriminator = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return true;
  }
  seen.add(node);
  const literal = staticStringValue(node);
  if (literal !== null) {
    return literal === "error";
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable === null ||
      mayBeErrorDiscriminator(context, stableInitializer(variable), seen)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      mayBeErrorDiscriminator(context, node.consequent, new Set(seen)) ||
      mayBeErrorDiscriminator(context, node.alternate, new Set(seen))
    );
  }
  return true;
};

// Resolve descriptor aliases lexically, including conditional branches and
// spread descriptors. Opaque values may create errors, so they are confined.
const containsErrorType = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return true;
  }
  seen.add(node);
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable === null ||
      containsErrorType(context, stableInitializer(variable), seen)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      containsErrorType(context, node.consequent, new Set(seen)) ||
      containsErrorType(context, node.alternate, new Set(seen))
    );
  }
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    return containsErrorType(context, node.right, new Set(seen));
  }
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return true;
  }
  return node.properties.some((property) => {
    if (!isAstNode(property)) {
      return false;
    }
    if (property.type === "SpreadElement") {
      return containsErrorType(context, property.argument, new Set(seen));
    }
    return (
      getPropertyName(property.key) === "type" &&
      mayBeErrorDiscriminator(context, property.value)
    );
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-direct-error-toast" },
  rules: {
    "no-direct-error-toast": {
      meta: {
        type: "problem",
        messages: {
          directError:
            "Route error toasts through notifyUserError so typed refusals use the shared user-facing copy.",
        },
      },
      createOnce(context) {
        let owned = false;
        return {
          before() {
            owned = isFileIn(context, OWNERS);
          },
          CallExpression(node) {
            if (owned) {
              return;
            }
            const method = toastMethod(context, node.callee);
            if (
              method === "error" ||
              method === "promise" ||
              method === "dynamic"
            ) {
              context.report({ node, messageId: "directError" });
              return;
            }
            if (method !== "add" && method !== "update") {
              return;
            }
            const descriptor = node.arguments.at(method === "add" ? 0 : 1);
            if (containsErrorType(context, descriptor)) {
              context.report({ node, messageId: "directError" });
            }
          },
        };
      },
    },
  },
});
