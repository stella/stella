// Keep validation timing and submission normalization at one owner. Require
// a direct helper call so spreading or mutating its result cannot silently
// replace the validator, submit handler, or revalidation logic.
import { eslintCompatPlugin } from "@oxlint/plugins";
import path from "node:path";

import {
  filenameForContext,
  getPropertyName,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const FORM_MODULES = new Set(["@tanstack/react-form", "@tanstack/form-core"]);
const FORM_FACTORIES = new Set(["useForm", "FormApi"]);

const staticName = (node) =>
  node.computed && !isStringLiteral(node.key ?? node.property)
    ? null
    : getPropertyName(node.key ?? node.property);

const variableFor = (node, context) => {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const importedBinding = (node, context, seen = new Set<unknown>()) => {
  const value = unwrapExpression(node);
  if (!value || seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (value.type === "Identifier") {
    const definition = variableFor(value, context)?.defs.at(0);
    if (definition?.type === "ImportBinding") {
      return {
        source: definition.parent.source.value,
        stable: true,
        name:
          definition.node.type === "ImportSpecifier"
            ? getPropertyName(definition.node.imported)
            : "*",
      };
    }
    if (definition?.node.type !== "VariableDeclarator") {
      return null;
    }
    const original = importedBinding(definition.node.init, context, seen);
    if (!original) {
      return null;
    }
    const stable = original.stable && definition.parent?.kind === "const";
    if (definition.node.id.type === "Identifier") {
      return { ...original, stable };
    }
    if (definition.node.id.type !== "ObjectPattern" || original?.name !== "*") {
      return null;
    }
    const property = definition.node.id.properties.find(
      (entry) =>
        entry.type === "Property" &&
        entry.value.type === "Identifier" &&
        entry.value.name === value.name,
    );
    return property
      ? { source: original.source, name: staticName(property), stable }
      : null;
  }
  if (value.type !== "MemberExpression") {
    return null;
  }
  const namespace = importedBinding(value.object, context, seen);
  return namespace?.name === "*"
    ? {
        source: namespace.source,
        name: staticName(value),
        stable: namespace.stable,
      }
    : null;
};

const isHelperSource = (source: string, context): boolean => {
  if (source === "@/lib/form-options") {
    return true;
  }
  if (!source.startsWith(".")) {
    return false;
  }
  const resolved = path.resolve(
    path.dirname(filenameForContext(context)),
    source,
  );
  return /\/apps\/web\/src\/lib\/form-options(?:\.[jt]s)?$/u.test(resolved);
};

export default eslintCompatPlugin({
  meta: { name: "require-schema-form-options" },
  rules: {
    "require-schema-form-options": {
      meta: {
        type: "problem",
        messages: {
          requireOptions:
            "Create forms with schemaFormOptions({ schema, defaultValues, submitValues, onSubmit }) directly. Choose 'schema-output' or 'raw' explicitly; the helper owns dynamic validation and submission normalization.",
          customHook:
            "Custom TanStack form hooks must preserve the schemaFormOptions contract. Extend the central form owner before introducing another form factory.",
        },
      },
      createOnce(context) {
        let hasFormImport = false;
        const checkCall = (node) => {
          if (!hasFormImport) {
            return;
          }
          const factory = importedBinding(node.callee, context);
          if (!factory || !FORM_MODULES.has(factory.source)) {
            return;
          }
          if (factory.name === "createFormHook") {
            context.report({ node, messageId: "customHook" });
            return;
          }
          if (!FORM_FACTORIES.has(factory.name)) {
            return;
          }
          const options = unwrapExpression(node.arguments.at(0));
          const helper =
            options?.type === "CallExpression"
              ? importedBinding(options.callee, context)
              : null;
          if (
            helper?.name === "schemaFormOptions" &&
            helper.stable &&
            isHelperSource(helper.source, context)
          ) {
            return;
          }
          context.report({ node, messageId: "requireOptions" });
        };
        return {
          Program(node) {
            hasFormImport = node.body.some(
              (statement) =>
                statement.type === "ImportDeclaration" &&
                FORM_MODULES.has(statement.source.value),
            );
          },
          CallExpression: checkCall,
          NewExpression: checkCall,
        };
      },
    },
  },
});
