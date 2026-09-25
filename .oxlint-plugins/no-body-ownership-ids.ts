// Disallow ownership IDs sourced from the request body or query.
// IDs that control data ownership or scoping (workspaceId,
// organizationId) must come from a server-validated source
// (SafeId from validateWorkspaceAccess, or
// ctx.session.activeOrganizationId), never from the request
// body or query params.
//
// Catches both direct access (body.workspaceId) and
// destructured access (const { workspaceId } = body).
//
// One sink is sanctioned: `resolveChatScope({ workspaceId: body.workspaceId })`
// hands the requested id straight to the resolver that authorizes it through
// getWorkspaceAccess and returns the server-validated id. The read is accepted
// only as the value of that call's own `workspaceId` property, recognised by
// import, so any other use of the same id is still reported.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type ImportedFromOptions,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isImportedFrom,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const AUTHORIZING_RESOLVERS: ReadonlySet<string> = new Set([
  "resolveChatScope",
]);
const AUTHORIZING_RESOLVER_MODULE = "apps/api/src/handlers/chat/chat-scope";

// Whether `node` is the `workspaceId` value in the options object passed to
// an authorizing resolver: `resolveChatScope({ workspaceId: <node> })`.
const isAuthorizingResolverArgument = (
  context: RuleContext,
  node: unknown,
): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const property = node.parent;
  if (
    !isAstNode(property) ||
    property.type !== "Property" ||
    property.value !== node ||
    getPropertyName(property.key) !== "workspaceId"
  ) {
    return false;
  }
  const options = property.parent;
  const call = isAstNode(options) ? options.parent : null;
  return (
    isAstNode(options) &&
    options.type === "ObjectExpression" &&
    isAstNode(call) &&
    call.type === "CallExpression" &&
    Array.isArray(call.arguments) &&
    call.arguments.at(0) === options &&
    isImportedFrom({
      context,
      node: invokedCallee(call),
      modules: [AUTHORIZING_RESOLVER_MODULE],
      names: AUTHORIZING_RESOLVERS,
    })
  );
};

const OWNERSHIP_FIELDS = new Set(["workspaceId", "organizationId"]);

const SOURCE_OBJECTS = new Set(["body", "query"]);

export default eslintCompatPlugin({
  meta: { name: "no-body-ownership-ids" },
  rules: {
    "no-body-ownership-ids": {
      meta: {
        type: "problem",
        messages: {
          bodyOwnershipId:
            "Ownership ID '{{object}}.{{property}}' must " +
            "come from a server-validated source (SafeId " +
            "from validateWorkspaceAccess or " +
            "ctx.session.activeOrganizationId), not from " +
            "the request {{object}}.",
          destructuredOwnershipId:
            "Ownership ID '{{property}}' destructured " +
            "from '{{object}}' must come from a " +
            "server-validated source, not from the " +
            "request {{object}}.",
        },
      },
      createOnce(context) {
        return {
          // body.workspaceId, query.organizationId
          MemberExpression(node) {
            if (node.computed) {
              return;
            }
            if (!isIdentifier(node.object) || !isIdentifier(node.property)) {
              return;
            }

            if (
              SOURCE_OBJECTS.has(node.object.name) &&
              OWNERSHIP_FIELDS.has(node.property.name) &&
              !(
                node.property.name === "workspaceId" &&
                isAuthorizingResolverArgument(context, node)
              )
            ) {
              context.report({
                node,
                messageId: "bodyOwnershipId",
                data: {
                  object: node.object.name,
                  property: node.property.name,
                },
              });
            }
          },

          // const { workspaceId } = body
          // const { workspaceId, ...rest } = query
          VariableDeclarator(node) {
            if (
              node.id.type !== "ObjectPattern" ||
              !isIdentifier(node.init) ||
              !SOURCE_OBJECTS.has(node.init.name)
            ) {
              return;
            }

            for (const prop of node.id.properties) {
              if (prop.type !== "Property") {
                continue;
              }
              // Handle both { workspaceId } and { ['workspaceId']: ws }
              const key = getPropertyName(prop.key);
              if (key !== null && OWNERSHIP_FIELDS.has(key)) {
                context.report({
                  node: prop,
                  messageId: "destructuredOwnershipId",
                  data: {
                    object: node.init.name,
                    property: key,
                  },
                });
              }
            }
          },
        };
      },
    },
  },
});
