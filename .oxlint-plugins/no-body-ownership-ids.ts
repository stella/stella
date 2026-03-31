// Disallow ownership IDs sourced from the request body or query.
//
// IDs that control data ownership or scoping (workspaceId,
// organizationId) must come from a server-validated source
// (SafeId from validateWorkspaceAccess, or
// ctx.session.activeOrganizationId), never from the request
// body or query params.
//
// Catches both direct access (body.workspaceId) and
// destructured access (const { workspaceId } = body).

const OWNERSHIP_FIELDS = new Set([
  "workspaceId",
  "organizationId",
]);

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
            if (node.computed) {return;}

            const object = node.object;
            const property = node.property;

            if (
              object.type !== "Identifier" ||
              property.type !== "Identifier"
            ) {
              return;
            }

            if (
              SOURCE_OBJECTS.has(object.name) &&
              OWNERSHIP_FIELDS.has(property.name)
            ) {
              context.report({
                node,
                messageId: "bodyOwnershipId",
                data: {
                  object: object.name,
                  property: property.name,
                },
              });
            }
          },

          // const { workspaceId } = body
          // const { workspaceId, ...rest } = query
          VariableDeclarator(node) {
            if (
              node.id.type !== "ObjectPattern" ||
              node.init?.type !== "Identifier" ||
              !SOURCE_OBJECTS.has(node.init.name)
            ) {
              return;
            }

            for (const prop of node.id.properties) {
              if (prop.type !== "Property") {continue;}
              // Handle both { workspaceId } and { ['workspaceId']: ws }
              const key =
                prop.key.type === "Identifier"
                  ? prop.key.name
                  : prop.key.type === "Literal" &&
                      typeof prop.key.value === "string"
                    ? prop.key.value
                    : null;
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
