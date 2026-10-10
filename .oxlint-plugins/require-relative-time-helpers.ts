// Relative and full timestamps must come from the canonical relative-time
// module and use the shared Tooltip affordance. A duplicate formatter omitted
// validation and calendar context, while inline locale formatting and native
// `title` attributes made otherwise identical timestamp cells behave
// differently.
//
// The ban is deliberately scoped to imports of the duplicated formatter
// names, `toLocaleString` option objects containing both dateStyle and
// timeStyle, and `title={formatFullTimestamp(...)}`. Other locale formatting,
// date-only labels, dense relative-time displays, and rich tooltip primitives
// remain valid. The `ad-hoc-relative-time-formatting` ratchet metric covers
// aliases and textual variants these exact AST shapes cannot identify.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isStringLiteral,
} from "./utils.ts";

const DUPLICATE_MODULE = "@/components/workspaces/entity-utils";
const CANONICAL_MODULE = "@/lib/relative-time";
const FORMATTER_NAMES = new Set(["formatFullTimestamp", "formatRelativeTime"]);

const staticName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (
    (node.type === "Identifier" || node.type === "JSXIdentifier") &&
    typeof node.name === "string"
  ) {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
};

const objectPropertyNames = (node: unknown): Set<string> => {
  if (!isAstNode(node) || node.type !== "ObjectExpression") {
    return new Set();
  }
  const names = new Set<string>();
  if (!Array.isArray(node.properties)) {
    return names;
  }
  for (const property of node.properties) {
    if (isAstNode(property) && property.type === "Property") {
      const name = staticName(property.key);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return names;
};

export default eslintCompatPlugin({
  meta: { name: "require-relative-time-helpers" },
  rules: {
    "require-relative-time-helpers": {
      meta: {
        type: "problem",
        messages: {
          duplicateImport:
            "Import timestamp formatters from '@/lib/relative-time'.",
          inlineFullTimestamp:
            "Use formatFullTimestamp(...) instead of an inline dateStyle + " +
            "timeStyle toLocaleString call.",
          nativeTitle:
            "Use the shared Tooltip component instead of a native title " +
            "attribute for a full timestamp.",
        },
      },
      createOnce(context) {
        const fullTimestampBindings = new Set(["formatFullTimestamp"]);
        let filename = "";
        return {
          before() {
            filename = filenameForContext(context);
            fullTimestampBindings.clear();
            fullTimestampBindings.add("formatFullTimestamp");
            return (
              filename.includes("apps/web/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/require-relative-time-helpers.fixture.tsx",
              )
            );
          },
          ImportDeclaration(node) {
            const source = node.source;
            if (!isStringLiteral(source) || !Array.isArray(node.specifiers)) {
              return;
            }
            if (source.value === CANONICAL_MODULE) {
              for (const specifier of node.specifiers) {
                if (getImportedName(specifier) === "formatFullTimestamp") {
                  const localName = getImportLocalName(specifier);
                  if (localName !== null) {
                    fullTimestampBindings.add(localName);
                  }
                }
              }
            }
            if (source.value !== DUPLICATE_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              const name = getImportedName(specifier);
              if (name !== null && FORMATTER_NAMES.has(name)) {
                context.report({
                  node: specifier,
                  messageId: "duplicateImport",
                });
              }
            }
          },
          CallExpression(node) {
            if (filename.endsWith("apps/web/src/lib/relative-time.ts")) {
              return;
            }
            const callee = node.callee;
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              staticName(callee.property) !== "toLocaleString" ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            for (const argument of node.arguments) {
              const names = objectPropertyNames(argument);
              if (names.has("dateStyle") && names.has("timeStyle")) {
                context.report({ node, messageId: "inlineFullTimestamp" });
                return;
              }
            }
          },
          JSXAttribute(node) {
            if (staticName(node.name) !== "title" || !isAstNode(node.value)) {
              return;
            }
            const openingElement = node.parent;
            if (
              isAstNode(openingElement) &&
              openingElement.type === "JSXOpeningElement" &&
              staticName(openingElement.name) === "ReadOnlyRow"
            ) {
              return;
            }
            const expression = node.value.expression;
            if (
              node.value.type === "JSXExpressionContainer" &&
              isAstNode(expression) &&
              expression.type === "CallExpression" &&
              fullTimestampBindings.has(staticName(expression.callee) ?? "")
            ) {
              context.report({ node, messageId: "nativeTitle" });
            }
          },
        };
      },
    },
  },
});
