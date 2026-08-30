// Publication retirement belongs to the buffer-intent reconciliation owner.
// A writer that deletes its cleanup intent directly can retire crash-recovery
// ownership outside the transaction that publishes the object reference.
//
// Flags direct deletes of the canonical schema binding in production API code:
//   tx.delete(bufferObjectCleanupIntents);
//
// Allows retirePublishedObjectCleanupIntentsInTransaction, deletes from other
// tables, tests, and the owning reconciliation module. This syntax guard tracks
// named aliases and namespace imports; it does not resolve arbitrary reexports
// or values passed through variables.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-buffer-cleanup-intent-delete";
const TABLE_NAME = "bufferObjectCleanupIntents";
const OWNER_PATH = "apps/api/src/lib/buffer-intent-reconciliation.ts";
const FIXTURE_PATH =
  ".oxlint-plugins/__fixtures__/no-direct-buffer-cleanup-intent-delete.fixture.ts";

const isSchemaModule = (specifier: string): boolean =>
  specifier === "@/api/db/schema" ||
  /(?:^|\/)db\/schema(?:\/entities)?(?:\.ts)?$/u.test(specifier);

const isTestFile = (filename: string): boolean =>
  filename.includes("/tests/") ||
  filename.includes("/__tests__/") ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directDelete:
            "Retire published buffer-object cleanup intents through retirePublishedObjectCleanupIntentsInTransaction so publication and retirement share one transaction.",
        },
        schema: [],
      },
      createOnce(context) {
        const directBindings = new Set<string>();
        const namespaceBindings = new Set<string>();

        const isCleanupIntentTable = (node: unknown): boolean => {
          const table = unwrapExpression(node);
          if (isIdentifier(table)) {
            return directBindings.has(table.name);
          }
          return (
            table?.type === "MemberExpression" &&
            isIdentifier(table.object) &&
            namespaceBindings.has(table.object.name) &&
            getPropertyName(table.property) === TABLE_NAME
          );
        };

        return {
          before() {
            directBindings.clear();
            namespaceBindings.clear();
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_PATH)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !filename.endsWith(OWNER_PATH) &&
              !isTestFile(filename)
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !isSchemaModule(node.source.value) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportNamespaceSpecifier" &&
                isIdentifier(specifier.local)
              ) {
                namespaceBindings.add(specifier.local.name);
                continue;
              }
              if (getImportedName(specifier) !== TABLE_NAME) {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                directBindings.add(localName);
              }
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              getPropertyName(callee.property) !== "delete" ||
              !Array.isArray(node.arguments) ||
              !isCleanupIntentTable(node.arguments.at(0))
            ) {
              return;
            }
            context.report({ node, messageId: "directDelete" });
          },
        };
      },
    },
  },
});
