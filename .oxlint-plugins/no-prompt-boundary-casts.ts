// Disallow direct casts to chat prompt boundary brands.
//
// The brands are minted by the chat prompt assembler only. Casting
// elsewhere bypasses the stable/safe/untrusted split that stream-chat
// relies on before sending prompt text across the third-party boundary.

const PROMPT_BOUNDARY_TYPES = new Set([
  "ChatCacheStablePrefix",
  "ChatSafePrompt",
  "ChatUntrustedPromptSuffix",
  "ChatFullPrompt",
]);

const ALLOWED_FILE = "apps/api/src/handlers/chat/chat-prompt.ts";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context) =>
  filenameForContext(context).replaceAll("\\", "/").endsWith(ALLOWED_FILE);

const typeName = (node) => {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "TSQualifiedName") {
    return typeName(node.right);
  }
  return null;
};

const castTargetName = (typeAnnotation) => {
  if (typeAnnotation?.type !== "TSTypeReference") {
    return null;
  }
  return typeName(typeAnnotation.typeName);
};

export default {
  meta: { name: "no-prompt-boundary-casts" },
  rules: {
    "no-prompt-boundary-casts": {
      meta: {
        type: "problem",
        messages: {
          noPromptBoundaryCast:
            "Do not cast to chat prompt boundary brands outside chat-prompt.ts. " +
            "Return branded values from the prompt assembler instead.",
        },
      },
      create(context) {
        if (isAllowedFile(context)) {
          return {};
        }

        function check(node) {
          const target = castTargetName(node.typeAnnotation);
          if (target === null || !PROMPT_BOUNDARY_TYPES.has(target)) {
            return;
          }

          context.report({ node, messageId: "noPromptBoundaryCast" });
        }

        return {
          TSAsExpression: check,
          TSTypeAssertion: check,
        };
      },
    },
  },
};
