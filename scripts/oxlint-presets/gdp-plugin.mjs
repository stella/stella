import plugin from "@gdp-ts/core/lint/plugin";

const noDefineProof = plugin.rules["no-define-proof"];

// Upstream 0.1.0 rejects named imports but omits calls through those bindings.
// Preserve call diagnostics, including renamed imports, until upstream fixes it.
export default {
  ...plugin,
  rules: {
    ...plugin.rules,
    "no-define-proof": {
      ...noDefineProof,
      create(context) {
        const upstream = noDefineProof.create(context);
        const constructors = new Set();
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
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.importKind !== "type" &&
                specifier.imported.name === "defineProof"
              ) {
                constructors.add(specifier.local.name);
              }
            }
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
