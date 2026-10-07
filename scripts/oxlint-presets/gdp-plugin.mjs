import plugin from "@gdp-ts/core/lint/plugin";

const noDefineProof = plugin.rules["no-define-proof"];

// Preserve named calls and constructor extractions alongside upstream checks.
export default {
  ...plugin,
  rules: {
    ...plugin.rules,
    "no-define-proof": {
      ...noDefineProof,
      create(context) {
        const upstream = noDefineProof.create(context);
        const constructors = new Set();
        const namespaces = new Set();
        const assignedValue = (node) =>
          node?.type === "AssignmentExpression"
            ? assignedValue(node.right)
            : node;
        const isConstructor = (node) => {
          const value = assignedValue(node);
          if (value?.type === "Identifier") {
            return constructors.has(value.name);
          }
          if (
            value?.type !== "MemberExpression" ||
            value.object.type !== "Identifier"
          ) {
            return false;
          }
          if (!namespaces.has(value.object.name)) {
            return false;
          }
          return value.computed
            ? value.property.value === "defineProof"
            : value.property.name === "defineProof";
        };
        const trackBinding = (target, value, node) => {
          if (isConstructor(value)) {
            if (target.type === "Identifier") {
              constructors.add(target.name);
            }
            context.report({
              node,
              message: "Only modules in proofs/ may extract defineProof.",
            });
            return;
          }
          const namespace = assignedValue(value);
          if (
            namespace?.type !== "Identifier" ||
            !namespaces.has(namespace.name)
          ) {
            return;
          }
          if (target.type === "Identifier") {
            namespaces.add(target.name);
            return;
          }
          if (target.type !== "ObjectPattern") {
            return;
          }
          for (const property of target.properties) {
            if (property.type !== "Property") {
              continue;
            }
            const key = property.computed
              ? property.key.value
              : (property.key.name ?? property.key.value);
            if (key !== "defineProof") {
              continue;
            }
            const binding =
              property.value.type === "AssignmentPattern"
                ? property.value.left
                : property.value;
            if (binding.type === "Identifier") {
              constructors.add(binding.name);
            }
            context.report({
              node: property,
              message: "Only modules in proofs/ may extract defineProof.",
            });
          }
        };
        return {
          ...upstream,
          ImportDeclaration(node) {
            upstream.ImportDeclaration(node);
            if (
              node.source.value !== "@gdp-ts/core" ||
              node.importKind === "type"
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                namespaces.add(specifier.local.name);
              }
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.importKind !== "type" &&
                specifier.imported.name === "defineProof"
              ) {
                constructors.add(specifier.local.name);
              }
            }
          },
          VariableDeclarator(node) {
            trackBinding(node.id, node.init, node);
          },
          AssignmentExpression(node) {
            trackBinding(node.left, node.right, node);
          },
          CallExpression(node) {
            upstream.CallExpression(node);
            if (
              node.callee.type === "Identifier" &&
              constructors.has(node.callee.name)
            ) {
              context.report({
                node,
                message: "Only modules in proofs/ may call defineProof.",
              });
            }
          },
        };
      },
    },
  },
};
