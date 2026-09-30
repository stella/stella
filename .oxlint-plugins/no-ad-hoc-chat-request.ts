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
  canonicalModuleId,
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  isTestFile,
  memberPropertyName,
  repoRelativeFilename,
} from "./utils.ts";

const CHAT_DIRECTORY = "apps/api/src/handlers/chat/";
const REQUEST_MODULE = "apps/api/src/handlers/chat/chat-request";
const FIXTURE =
  ".oxlint-plugins/__fixtures__/no-ad-hoc-chat-request.fixture.ts";

/** The builders only the request module may call, by the module that
 *  exports them, as canonical repository paths: an alias, a relative path
 *  and an extension all name the same module. */
const OWNED_BUILDERS: Readonly<Record<string, readonly string[]>> = {
  "apps/api/src/lib/chat/provider-tool-projection": [
    "projectChatToolSchemasForProvider",
  ],
  "apps/api/src/lib/tanstack-ai-generate": [
    "mergeGenerationOptions",
    "systemPromptsPatch",
  ],
};

/** A module id names `path` when it ends with it (a file outside the
 *  repository root resolves to an absolute id). */
const namesModule = (moduleId: string, path: string): boolean =>
  moduleId === path || moduleId.endsWith(`/${path}`);

const ownedBuildersOf = (moduleId: string): readonly string[] =>
  Object.entries(OWNED_BUILDERS).find(([path]) =>
    namesModule(moduleId, path),
  )?.[1] ?? [];

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
        /** Namespace imports of a module that owns a builder, with the
         *  builders it owns. */
        const ownerNamespaces = new Map<string, readonly string[]>();
        /** A value taken straight from a request-module call. */
        const isRequestModuleCall = (node: unknown): boolean =>
          isAstNode(node) &&
          node.type === "CallExpression" &&
          isIdentifier(node.callee) &&
          requestBuilders.has(node.callee.name);
        return {
          before() {
            requestBuilders.clear();
            ownerNamespaces.clear();
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE) ||
              (filename.includes(CHAT_DIRECTORY) &&
                !canonicalModuleId(filename, filename).endsWith(
                  REQUEST_MODULE,
                ) &&
                !isTestFile(filename))
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            const moduleId = canonicalModuleId(
              node.source.value,
              repoRelativeFilename(context),
            );
            const owned = ownedBuildersOf(moduleId);
            const isRequestModule = namesModule(moduleId, REQUEST_MODULE);
            for (const specifier of node.specifiers) {
              if (
                isAstNode(specifier) &&
                specifier.type === "ImportNamespaceSpecifier" &&
                isIdentifier(specifier.local) &&
                owned.length > 0
              ) {
                ownerNamespaces.set(specifier.local.name, owned);
                continue;
              }
              if (isRequestModule) {
                const local = getImportLocalName(specifier);
                if (local !== null) {
                  requestBuilders.add(local);
                }
                continue;
              }
              const imported = getImportedName(specifier);
              if (imported !== null && owned.includes(imported)) {
                context.report({ node: specifier, messageId: "ownedBuilder" });
              }
            }
          },
          MemberExpression(node) {
            const owned = isIdentifier(node.object)
              ? ownerNamespaces.get(node.object.name)
              : undefined;
            const name = memberPropertyName(node);
            if (owned !== undefined && name !== null && owned.includes(name)) {
              context.report({ node, messageId: "ownedBuilder" });
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
