import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
// Require `satisfies WorkspaceHandlerConfig` on a config passed to
// `createSafeHandler`.
//
// `createSafeHandler` mounts under a `:workspaceId` prefix and its parameter
// type is `WorkspaceHandlerConfig`, whose `params` slot rejects a schema that
// omits `workspaceId`. A route-level params schema that omits it fails Elysia's
// validation for every request, before authentication.
//
// `satisfies` does not widen, so `satisfies HandlerConfig` on a workspace
// config still typechecks: the constraint is only checked at the
// `createSafeHandler(...)` call, several lines from the schema. That gap is
// what lets the two spellings drift, and the wider annotation reads as
// permission to write a params schema the factory will reject. Naming the
// narrow type at the declaration keeps the error where the mistake is.
//
// Flagged:
//   const config = { params: t.Object({ listId }) } satisfies HandlerConfig;
//   export default createSafeHandler(config, handler);
//
// Allowed:
//   const config = { … } satisfies WorkspaceHandlerConfig;   // workspace route
//   const config = { … } satisfies HandlerConfig;            // root route
//   export default createSafeRootHandler(config, handler);
//
// Configs for `createSafeRootHandler`, `createSafeTokenHandler`,
// `createSafeSessionHandler`, and `createSafePublicHandler` carry their own
// config types and are not flagged.

import type { AstNode } from "./utils.ts";
import { isAstNode, isIdentifier } from "./utils.ts";

const FACTORY = "createSafeHandler";
const WIDE_CONFIG_TYPE = "HandlerConfig";

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

/** The expression itself when it reads `<value> satisfies HandlerConfig`. */
const wideConfigSatisfies = (node: unknown): AstNode | null => {
  if (!isAstNode(node) || node.type !== "TSSatisfiesExpression") {
    return null;
  }
  const annotation = node.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeReference") {
    return null;
  }
  return isIdentifier(annotation.typeName, WIDE_CONFIG_TYPE) ? node : null;
};

export default eslintCompatPlugin({
  meta: { name: "require-workspace-handler-config" },
  rules: {
    "require-workspace-handler-config": {
      meta: {
        type: "problem",
        messages: {
          requireWorkspaceHandlerConfig:
            "A config passed to createSafeHandler must be pinned with " +
            "`satisfies WorkspaceHandlerConfig`, not `satisfies " +
            "HandlerConfig`. The narrow type is what requires the params " +
            "schema to declare workspaceId, so the error lands on the schema " +
            "rather than on the factory call.",
        },
      },
      createOnce(context) {
        // The initializer of the `const` this identifier denotes, or null when
        // the binding is a parameter, an import, or a reassignable `let`.
        const constInitializer = (
          identifierNode: ESTree.IdentifierReference,
        ): unknown => {
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(identifierNode);
          while (scope) {
            const variable = scope.set.get(identifierNode.name);
            if (variable) {
              for (const def of variable.defs) {
                if (
                  def.type === "Variable" &&
                  isAstNode(def.node) &&
                  def.node.type === "VariableDeclarator" &&
                  isAstNode(def.parent) &&
                  def.parent.type === "VariableDeclaration" &&
                  def.parent.kind === "const"
                ) {
                  return def.node.init;
                }
              }
              return null;
            }
            scope = scope.upper;
          }
          return null;
        };

        return {
          CallExpression(node) {
            if (!isIdentifier(node.callee, FACTORY)) {
              return;
            }
            const configArgument = node.arguments.at(0);

            // An inline `createSafeHandler({ … } satisfies HandlerConfig, …)`
            // carries the annotation on the argument itself.
            const inline = wideConfigSatisfies(configArgument);
            if (inline) {
              context.report({
                node: inline,
                messageId: "requireWorkspaceHandlerConfig",
              });
              return;
            }

            if (!isIdentifierReference(configArgument)) {
              return;
            }
            // Report on the declaration: that is where the annotation is
            // written and where the fix goes.
            const declared = wideConfigSatisfies(
              constInitializer(configArgument),
            );
            if (declared) {
              context.report({
                node: declared,
                messageId: "requireWorkspaceHandlerConfig",
              });
            }
          },
        };
      },
    },
  },
});
