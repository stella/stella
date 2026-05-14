// Disallow ownership IDs sourced from the request body or query.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// IDs that control data ownership or scoping (workspaceId,
// organizationId) must come from a server-validated source
// (SafeId from validateWorkspaceAccess, or
// ctx.session.activeOrganizationId), never from the request
// body or query params.
//
// Catches both direct access (body.workspaceId) and
// destructured access (const { workspaceId } = body).

import { getPropertyName, isIdentifier } from "./utils.ts";

const OWNERSHIP_FIELDS = new Set(["workspaceId", "organizationId"]);

const SOURCE_OBJECTS = new Set(["body", "query"]);

export default {
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
      create(context) {
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
              OWNERSHIP_FIELDS.has(node.property.name)
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
};
