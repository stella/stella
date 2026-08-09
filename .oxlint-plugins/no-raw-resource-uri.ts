// Resource names and chat links carry opaque IDs. Constructing either format
// outside its canonical serializer can skip strict component encoding and
// break persistence or Markdown parsing for valid IDs.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isCallTo,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RAW_RESOURCE_URI_PREFIXES = [
  "#stella-decision=",
  "#stella-entity=",
  "#stella-workspace=",
  "stella://resource/",
] as const;

const RESOURCE_URI_PREFIX_BINDINGS = new Set([
  "CHAT_MENTION_HREF_PREFIXES",
  "CHAT_REFERENCE_HREF_PREFIXES",
  "CHAT_RESOURCE_HREF_PREFIX",
  "RESOURCE_NAME_PREFIX",
]);

const containsRawResourceUriPrefix = (value: string): boolean =>
  RAW_RESOURCE_URI_PREFIXES.some((prefix) => value.includes(prefix));

const templateElementText = (value: unknown): string | null => {
  if (!isAstNode(value) || value.type !== "TemplateElement") {
    return null;
  }
  const templateValue = value.value;
  if (typeof templateValue !== "object" || templateValue === null) {
    return null;
  }
  const cooked = Object.getOwnPropertyDescriptor(
    templateValue,
    "cooked",
  )?.value;
  if (typeof cooked === "string") {
    return cooked;
  }
  const raw = Object.getOwnPropertyDescriptor(templateValue, "raw")?.value;
  return typeof raw === "string" ? raw : null;
};

const templateContainsRawResourceUriPrefix = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "TemplateLiteral" &&
  Array.isArray(node.quasis) &&
  node.quasis.some((quasi) => {
    const text = templateElementText(quasi);
    return text !== null && containsRawResourceUriPrefix(text);
  });

const referencesResourceUriPrefix = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (isIdentifier(node)) {
    return RESOURCE_URI_PREFIX_BINDINGS.has(node.name);
  }
  if (node.type === "MemberExpression") {
    return referencesResourceUriPrefix(node.object);
  }
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    return (
      referencesResourceUriPrefix(node.left) ||
      referencesResourceUriPrefix(node.right)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      referencesResourceUriPrefix(node.consequent) ||
      referencesResourceUriPrefix(node.alternate)
    );
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions)) {
    return node.expressions.some(referencesResourceUriPrefix);
  }
  return false;
};

const isConcatCallOnResourceUriPrefix = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    getPropertyName(callee.property) === "concat" &&
    referencesResourceUriPrefix(callee.object)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-resource-uri" },
  rules: {
    "no-raw-resource-uri": {
      meta: {
        type: "problem",
        messages: {
          rawResourceUri:
            "Construct resource names with toResourceName() and chat links " +
            "with toChatResourceHref() or toChatMentionResourceHref(); the " +
            "canonical serializers encode opaque IDs safely.",
        },
      },
      createOnce(context) {
        const report = (node: unknown): void => {
          if (isAstNode(node)) {
            context.report({ node, messageId: "rawResourceUri" });
          }
        };

        return {
          BinaryExpression(node) {
            if (
              node.operator === "+" &&
              (referencesResourceUriPrefix(node.left) ||
                referencesResourceUriPrefix(node.right))
            ) {
              report(node);
            }
          },
          CallExpression(node) {
            if (isConcatCallOnResourceUriPrefix(node)) {
              report(node);
            }
          },
          Literal(node) {
            if (
              isStringLiteral(node) &&
              containsRawResourceUriPrefix(node.value)
            ) {
              report(node);
            }
          },
          TemplateLiteral(node) {
            if (
              templateContainsRawResourceUriPrefix(node) ||
              (Array.isArray(node.expressions) &&
                node.expressions.some(referencesResourceUriPrefix))
            ) {
              report(node);
            }
          },
        };
      },
    },
    "require-rfc3986-resource-encoding": {
      meta: {
        type: "problem",
        messages: {
          strictResourceEncoding:
            "Encode opaque resource IDs with encodeRfc3986Component(), not " +
            "encodeURIComponent().",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (isCallTo(node, "encodeURIComponent")) {
              context.report({
                node,
                messageId: "strictResourceEncoding",
              });
            }
          },
        };
      },
    },
  },
});
