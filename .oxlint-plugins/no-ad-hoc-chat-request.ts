// A chat surface's provider request is shaped in one module,
// `apps/api/src/handlers/chat/chat-request.ts`: it projects the tools for the
// provider, splits the system prompt at its cacheable layers and places the
// cache markers, and merges the generation options. A second place that did
// any of it would send a prompt the cache layering never saw: a system prompt
// without its markers, or tools in another order, which misses the cache on
// every request without an error.
//
// Under `apps/api/src/handlers/chat/` (tests aside), outside that module:
// - `systemPromptsPatch`, `mergeGenerationOptions` and
//   `projectChatToolSchemasForProvider` are not imported;
// - a `systemPrompts` property or assignment takes its value straight from a
//   call to a function imported from the module.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  isTestFile,
} from "./utils.ts";

const CHAT_DIRECTORY = "apps/api/src/handlers/chat/";
const REQUEST_MODULE = "apps/api/src/handlers/chat/chat-request.ts";
const REQUEST_MODULE_SPECIFIER = "@/api/handlers/chat/chat-request";

/** The builders only the request module may call, by the module that
 *  exports them. */
const OWNED_BUILDERS: Readonly<Record<string, readonly string[]>> = {
  "@/api/lib/chat/provider-tool-projection": [
    "projectChatToolSchemasForProvider",
  ],
  "@/api/lib/tanstack-ai-generate": [
    "mergeGenerationOptions",
    "systemPromptsPatch",
  ],
};

export default eslintCompatPlugin({
  meta: { name: "no-ad-hoc-chat-request" },
  rules: {
    "no-ad-hoc-chat-request": {
      meta: {
        type: "problem",
        messages: {
          ownedBuilder:
            "Build a chat request through handlers/chat/chat-request.ts " +
            "(chatRequestOptions, chatAttemptRequestOptions): it places the " +
            "cache markers at the prompt's layer boundaries.",
          systemPrompts:
            "Take systemPrompts from handlers/chat/chat-request.ts " +
            "(chatRequestOptions or chatSystemPrompts), so the system prompt " +
            "keeps its cache layers.",
        },
      },
      createOnce(context) {
        const requestBuilders = new Set<string>();
        /** A value taken straight from a request-module call. */
        const isRequestModuleCall = (node: unknown): boolean =>
          isAstNode(node) &&
          node.type === "CallExpression" &&
          isIdentifier(node.callee) &&
          requestBuilders.has(node.callee.name);
        return {
          before() {
            requestBuilders.clear();
            const filename = filenameForContext(context);
            return (
              filename.includes(CHAT_DIRECTORY) &&
              !filename.endsWith(REQUEST_MODULE) &&
              !isTestFile(filename)
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            const source = node.source.value;
            const owned = OWNED_BUILDERS[source];
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              if (source === REQUEST_MODULE_SPECIFIER) {
                const local = getImportLocalName(specifier);
                if (local !== null) {
                  requestBuilders.add(local);
                }
                continue;
              }
              if (imported !== null && owned?.includes(imported) === true) {
                context.report({ node: specifier, messageId: "ownedBuilder" });
              }
            }
          },
          Property(node) {
            if (
              node.computed !== true &&
              getPropertyName(node.key) === "systemPrompts" &&
              !isRequestModuleCall(node.value)
            ) {
              context.report({ node, messageId: "systemPrompts" });
            }
          },
          AssignmentExpression(node) {
            const target = node.left;
            if (
              isAstNode(target) &&
              target.type === "MemberExpression" &&
              target.computed !== true &&
              getPropertyName(target.property) === "systemPrompts" &&
              !isRequestModuleCall(node.right)
            ) {
              context.report({ node, messageId: "systemPrompts" });
            }
          },
        };
      },
    },
  },
});
