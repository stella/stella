// Keep Unicode normalization semantics at @stll/text-normalize. This rule is
// intentionally syntax-based because the native operation and the equivalent
// mark-removal expressions must remain visible even without type information.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, getPropertyName, isAstNode } from "./utils.ts";

const NODE_PATH_SPECIFIERS = new Set([
  "node:path",
  "node:path/posix",
  "node:path/win32",
  "path",
  "path/posix",
  "path/win32",
]);

const isMarkRemovalPattern = (source: string): boolean => {
  const lastSlash = source.lastIndexOf("/");
  if (!source.startsWith("/") || lastSlash === 0) {
    return false;
  }
  const pattern = source.slice(1, lastSlash);
  return (
    /\\p\{(?:M|Mn|Diacritic)\}/u.test(pattern) ||
    pattern.includes("[\\u0300-\\u036f]") ||
    pattern.includes("[̀-ͯ]")
  );
};

// A run of rejected characters collapsed into one separator is slugify() in the
// owner: the same allowed set (ASCII alphanumerics or Unicode letters and
// numbers, optionally with the separator itself) and the same replacement.
// Classes that allow anything else (a dot, a space) are different keys.
const SLUG_RUN_PATTERN =
  /^\/\[\^(?:a-z0-9|0-9a-z|\\da-z|a-z\\d|\\p\{L\}\\p\{N\})[-_]?\]\+\/[a-z]*$/u;

const isSlugSeparatorLiteral = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "Literal" &&
  (node.value === "-" || node.value === "_");

// Only deleting the marks is equivalent to the owner; any other replacement
// (a separator, a callback) is different behaviour and stays allowed.
const isEmptyStringLiteral = (node: unknown): boolean =>
  isAstNode(node) &&
  ((node.type === "Literal" && node.value === "") ||
    (node.type === "TemplateLiteral" &&
      Array.isArray(node.expressions) &&
      node.expressions.length === 0 &&
      Array.isArray(node.quasis) &&
      node.quasis.every(
        (quasi: unknown) =>
          isAstNode(quasi) &&
          typeof quasi.value === "object" &&
          quasi.value !== null &&
          "cooked" in quasi.value &&
          quasi.value.cooked === "",
      )));

export default eslintCompatPlugin({
  meta: { name: "no-direct-unicode-normalize" },
  rules: {
    "no-direct-unicode-normalize": {
      meta: {
        type: "problem",
        messages: {
          direct:
            "Use normalizeUnicode() from @stll/text-normalize so Unicode normalization has one owner.",
          slug: "Use slugify() from @stll/text-normalize so slug rules (charset, budget, fallback) have one owner.",
          markStrip:
            "Use stripUnicodeMarks() or stripDiacritics() from @stll/text-normalize so mark-removal semantics stay explicit.",
        },
      },
      createOnce(context) {
        const nodePathBindings = new Set<string>();
        let isOwnerFile = false;

        return {
          before() {
            nodePathBindings.clear();
            isOwnerFile = filenameForContext(context).includes(
              "packages/text-normalize/",
            );
          },
          ImportDeclaration(node) {
            if (isOwnerFile) {
              return;
            }
            if (
              typeof node.source.value !== "string" ||
              !NODE_PATH_SPECIFIERS.has(node.source.value)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                isAstNode(specifier) &&
                specifier.type !== "ImportSpecifier" &&
                isAstNode(specifier.local)
              ) {
                nodePathBindings.add(specifier.local.name);
              }
            }
          },
          CallExpression(node) {
            if (isOwnerFile) {
              return;
            }
            if (
              !isAstNode(node.callee) ||
              node.callee.type !== "MemberExpression"
            ) {
              return;
            }
            const property = getPropertyName(node.callee.property);
            if (
              (property === "replace" || property === "replaceAll") &&
              node.arguments.length >= 2 &&
              isEmptyStringLiteral(node.arguments[1]) &&
              isMarkRemovalPattern(
                context.sourceCode.getText(node.arguments[0]),
              )
            ) {
              context.report({ node, messageId: "markStrip" });
              return;
            }
            if (
              (property === "replace" || property === "replaceAll") &&
              node.arguments.length >= 2 &&
              isSlugSeparatorLiteral(node.arguments[1]) &&
              SLUG_RUN_PATTERN.test(
                context.sourceCode.getText(node.arguments[0]),
              )
            ) {
              context.report({ node, messageId: "slug" });
              return;
            }
            if (property !== "normalize") {
              return;
            }
            const receiver = node.callee.object;
            if (isAstNode(receiver) && receiver.type === "ObjectExpression") {
              return;
            }
            const isNodePath =
              isAstNode(receiver) &&
              ((receiver.type === "Identifier" &&
                nodePathBindings.has(receiver.name)) ||
                (receiver.type === "MemberExpression" &&
                  isAstNode(receiver.object) &&
                  receiver.object.type === "Identifier" &&
                  nodePathBindings.has(receiver.object.name)));
            if (!isNodePath) {
              context.report({ node, messageId: "direct" });
            }
          },
        };
      },
    },
  },
});
