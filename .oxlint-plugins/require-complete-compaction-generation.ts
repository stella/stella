// Keep chat compaction generation on its complete-output policy.
//
// A compaction summary replaces a durable source window and advances its
// checkpoint. Calling generateTanStackTextForRole directly without spreading
// COMPACTION_GENERATION_POLICY can therefore persist an output-ceiling prefix
// and permanently skip the missing suffix. This rule inventories every direct
// TanStack text-generation call in production modules whose filename owns a
// compaction flow, including aliased imports, and requires the shared policy.
//
// Known boundary: compaction entry points must retain "compaction" in their
// filename. The vertical slice already uses that ownership convention; a new
// differently named compactor needs either this rule's scope widened or its own
// explicit guard.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportLocalName,
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const GENERATE_TEXT_EXPORT = "generateTanStackTextForRole";
const GENERATE_TEXT_MODULE = "@/api/lib/tanstack-ai-generate";
const POLICY_EXPORT = "COMPACTION_GENERATION_POLICY";
const POLICY_MODULE = "@/api/lib/chat/compaction-tokens";
const FIXTURE_SUFFIX =
  ".oxlint-plugins/__fixtures__/require-complete-compaction-generation.fixture.ts";
const COMPACTION_MODULE = /(?:^|\/)[^/]*compaction[^/]*\.ts$/u;

const isTargetFile = (filename: string): boolean =>
  filename.endsWith(FIXTURE_SUFFIX) ||
  (filename.includes("apps/api/src/") &&
    COMPACTION_MODULE.test(filename) &&
    !filename.endsWith(".test.ts") &&
    !filename.endsWith(".integration.test.ts"));

export default eslintCompatPlugin({
  meta: { name: "require-complete-compaction-generation" },
  rules: {
    "require-complete-compaction-generation": {
      meta: {
        type: "problem",
        messages: {
          missingPolicy:
            "Spread COMPACTION_GENERATION_POLICY into every compaction generateTanStackTextForRole call; a truncated summary must not advance a durable checkpoint.",
        },
        schema: [],
      },
      createOnce(context) {
        const generateTextBindings = new Set<string>();
        const policyBindings = new Set<string>();

        return {
          before() {
            return isTargetFile(filenameForContext(context));
          },
          ImportDeclaration(node) {
            if (!isStringLiteral(node.source)) {
              return;
            }
            const bindings =
              node.source.value === GENERATE_TEXT_MODULE
                ? {
                    exportName: GENERATE_TEXT_EXPORT,
                    localNames: generateTextBindings,
                  }
                : node.source.value === POLICY_MODULE
                  ? { exportName: POLICY_EXPORT, localNames: policyBindings }
                  : null;
            if (bindings === null || !Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) !== bindings.exportName) {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                bindings.localNames.add(localName);
              }
            }
          },
          CallExpression(node) {
            if (
              !isIdentifier(node.callee) ||
              !generateTextBindings.has(node.callee.name)
            ) {
              return;
            }
            const firstArgument = unwrapExpression(node.arguments.at(0));
            const properties =
              firstArgument?.type === "ObjectExpression" &&
              Array.isArray(firstArgument.properties)
                ? firstArgument.properties
                : [];
            const hasPolicy = properties.some(
              (property) =>
                isAstNode(property) &&
                property.type === "SpreadElement" &&
                isIdentifier(property.argument) &&
                policyBindings.has(property.argument.name),
            );
            if (!hasPolicy) {
              context.report({ node, messageId: "missingPolicy" });
            }
          },
        };
      },
    },
  },
});
