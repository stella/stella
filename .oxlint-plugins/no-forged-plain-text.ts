// PlainText proves the shared sanitizer ran. Assertions and claimed type
// predicates cannot supply that proof, including through local aliases.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode, isIdentifier } from "./utils.ts";

const OWNER = "/apps/api/src/lib/case-law/plain-text.ts";
const PROOF_TYPES = new Set([
  "PlainText",
  "PlainTextMetadataValue",
  "IngestionResult",
]);

export default eslintCompatPlugin({
  meta: { name: "no-forged-plain-text" },
  rules: {
    "no-forged-plain-text": {
      meta: {
        type: "problem",
        messages: {
          forged:
            "Only the shared plain-text sanitizer may construct PlainText. Call toPlainText instead of asserting or declaring its proof.",
        },
      },
      createOnce(context) {
        const names = new Set<string>();
        const aliases = new Map<string, unknown>();
        const pending: { node: unknown; typeAnnotation: unknown }[] = [];
        let owner = false;

        const containsPlainText = (
          value: unknown,
          seen = new Set<string>(),
        ): boolean => {
          if (!isAstNode(value)) {
            return Array.isArray(value)
              ? value.some((item) => containsPlainText(item, seen))
              : false;
          }
          if (isIdentifier(value)) {
            if (names.has(value.name)) {
              return true;
            }
            const alias = aliases.get(value.name);
            if (alias !== undefined && !seen.has(value.name)) {
              const next = new Set(seen);
              next.add(value.name);
              return containsPlainText(alias, next);
            }
            return false;
          }
          if (
            value.type === "TSQualifiedName" &&
            isIdentifier(value.right) &&
            PROOF_TYPES.has(value.right.name)
          ) {
            return true;
          }
          return Object.entries(value).some(
            ([key, child]) =>
              key !== "parent" && containsPlainText(child, seen),
          );
        };

        const assertion = (node: unknown): void => {
          if (isAstNode(node)) {
            pending.push({ node, typeAnnotation: node.typeAnnotation });
          }
        };

        return {
          before() {
            names.clear();
            for (const name of PROOF_TYPES) {
              names.add(name);
            }
            aliases.clear();
            pending.length = 0;
            owner = filenameForContext(context).endsWith(OWNER);
          },
          ImportSpecifier(node) {
            if (
              isIdentifier(node.imported) &&
              PROOF_TYPES.has(node.imported.name) &&
              isIdentifier(node.local)
            ) {
              names.add(node.local.name);
            }
          },
          TSTypeAliasDeclaration(node) {
            if (!isIdentifier(node.id)) {
              return;
            }
            aliases.set(node.id.name, node.typeAnnotation);
            if (!owner && node.id.name === "PlainText") {
              context.report({ node, messageId: "forged" });
            }
          },
          TSInterfaceDeclaration(node) {
            if (!owner && isIdentifier(node.id, "PlainText")) {
              context.report({ node, messageId: "forged" });
            }
          },
          TSAsExpression: assertion,
          TSTypeAssertion: assertion,
          TSTypePredicate: assertion,
          ExportSpecifier(node) {
            if (
              isIdentifier(node.local) &&
              isIdentifier(node.exported) &&
              !PROOF_TYPES.has(node.exported.name)
            ) {
              pending.push({ node, typeAnnotation: node.local });
            }
          },
          "Program:exit"() {
            if (owner) {
              return;
            }
            for (const { node, typeAnnotation } of pending) {
              if (isAstNode(node) && containsPlainText(typeAnnotation)) {
                context.report({ node, messageId: "forged" });
              }
            }
          },
        };
      },
    },
  },
});
