// Ban direct crypto.randomUUID() use in application code.
//
// UUID generation belongs behind the runtime's UUIDv7 owner so generated
// identifiers are time ordered and callers do not choose their own primitive.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getImportedName, isAstNode, isIdentifier } from "./utils.ts";

const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const DIRECT_UUID_GENERATORS = new Set(["v4", "v7"]);

export default eslintCompatPlugin({
  meta: { name: "no-crypto-random-uuid" },
  rules: {
    "no-crypto-random-uuid": {
      meta: {
        type: "problem",
        messages: {
          noCryptoRandomUuid:
            "Do not use crypto.randomUUID() directly. " +
            "Use the runtime's UUIDv7 owner instead.",
          noCryptoRandomUuidImport:
            "Do not import randomUUID from '{{module}}'. " +
            "Use the UUID owner for this runtime instead.",
          noDirectUuidGeneratorImport:
            "Do not import {{generator}} directly from 'uuid'. " +
            "Use the UUID owner for this runtime instead.",
        },
      },
      createOnce(context) {
        const randomUuidAliases = new Set();
        const cryptoAliases = new Set(["crypto"]);

        return {
          before() {
            randomUuidAliases.clear();
            cryptoAliases.clear();
            cryptoAliases.add("crypto");
          },
          ImportDeclaration(node) {
            if (typeof node.source.value !== "string") {
              return;
            }

            if (node.source.value === "uuid") {
              for (const specifier of node.specifiers) {
                const importedName = getImportedName(specifier);
                if (
                  importedName !== null &&
                  DIRECT_UUID_GENERATORS.has(importedName)
                ) {
                  context.report({
                    node: specifier,
                    messageId: "noDirectUuidGeneratorImport",
                    data: { generator: importedName },
                  });
                }
              }
              return;
            }

            if (!CRYPTO_MODULES.has(node.source.value)) {
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

              if (getImportedName(specifier) === "randomUUID") {
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

            if (isIdentifier(callee) && randomUuidAliases.has(callee.name)) {
              context.report({
                node,
                messageId: "noCryptoRandomUuid",
              });
              return;
            }

            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              !isIdentifier(callee.property, "randomUUID") ||
              !isCryptoObject(callee.object, cryptoAliases)
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
});

const isCryptoObject = (node: unknown, cryptoAliases: Set<string>): boolean => {
  if (isIdentifier(node) && cryptoAliases.has(node.name)) {
    return true;
  }

  return (
    isAstNode(node) &&
    node.type === "MemberExpression" &&
    node.computed === false &&
    isIdentifier(node.object, "globalThis") &&
    isIdentifier(node.property, "crypto")
  );
};
