// Ban crypto.randomUUID() in Bun-runtime code.
//
// Backend code runs on Bun; use Bun.randomUUIDv7() so generated
// UUIDs are Bun-native and database-friendly for ordered inserts.

const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);

export default {
  meta: { name: "no-crypto-random-uuid" },
  rules: {
    "no-crypto-random-uuid": {
      meta: {
        type: "problem",
        messages: {
          noCryptoRandomUuid:
            "Do not use crypto.randomUUID() in Bun-runtime code. " +
            "Use Bun.randomUUIDv7() instead.",
          noCryptoRandomUuidImport:
            "Do not import randomUUID from '{{module}}'. " +
            "Use Bun.randomUUIDv7() instead.",
        },
      },
      create(context) {
        const randomUuidAliases = new Set();
        const cryptoAliases = new Set(["crypto"]);

        return {
          ImportDeclaration(node) {
            if (
              typeof node.source.value !== "string" ||
              !CRYPTO_MODULES.has(node.source.value)
            ) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportDefaultSpecifier") {
                cryptoAliases.add(specifier.local.name);
                continue;
              }

              if (specifier.type === "ImportNamespaceSpecifier") {
                cryptoAliases.add(specifier.local.name);
                continue;
              }

              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                specifier.imported.name === "randomUUID"
              ) {
                randomUuidAliases.add(specifier.local.name);
                context.report({
                  node: specifier,
                  messageId: "noCryptoRandomUuidImport",
                  data: { module: node.source.value },
                });
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            if (
              callee.type === "Identifier" &&
              randomUuidAliases.has(callee.name)
            ) {
              context.report({
                node,
                messageId: "noCryptoRandomUuid",
              });
              return;
            }

            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              callee.object.type !== "Identifier" ||
              callee.property.type !== "Identifier" ||
              callee.property.name !== "randomUUID" ||
              !cryptoAliases.has(callee.object.name)
            ) {
              return;
            }

            context.report({
              node,
              messageId: "noCryptoRandomUuid",
            });
          },
        };
      },
    },
  },
};
