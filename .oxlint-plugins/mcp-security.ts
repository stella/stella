// MCP-specific security guardrails.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// These rules encode invariants that TypeScript cannot infer from Drizzle's
// query builder alone:
//   1. OAuth dynamic registration responses must be redacted before JSONB
//      persistence, because some authorization servers return client secrets or
//      registration access tokens in the raw response.
//   2. MCP user connections must join OAuth client credentials by the exact
//      authorization server URL used for that connection, not only by connector.
//   3. OAuth refresh must use the persisted protected-resource URL; falling
//      back to connector URL can silently address the wrong resource.

const MCP_OAUTH_CLIENTS = "mcpOAuthClients";
const MCP_USER_CONNECTIONS = "mcpUserConnections";

const getPropertyName = (node) => {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
};

const isIdentifier = (node, name) =>
  node?.type === "Identifier" && node.name === name;

const isMember = (node, objectName, propertyName) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  isIdentifier(node.object, objectName) &&
  isIdentifier(node.property, propertyName);

const isRedactionCall = (node) =>
  node?.type === "CallExpression" &&
  isIdentifier(node.callee, "redactMcpOAuthRegistrationResponse");

const isJoinCall = (node) => {
  if (node.type !== "CallExpression") {
    return false;
  }

  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    (isIdentifier(callee.property, "leftJoin") ||
      isIdentifier(callee.property, "innerJoin")) &&
    isIdentifier(node.arguments.at(0), MCP_OAUTH_CLIENTS)
  );
};

const hasAuthorizationServerJoinPredicate = (node) => {
  if (!node) {
    return false;
  }

  if (
    node.type === "CallExpression" &&
    isIdentifier(node.callee, "eq") &&
    hasBothAuthorizationServerMembers(node.arguments)
  ) {
    return true;
  }

  return childNodes(node).some(hasAuthorizationServerJoinPredicate);
};

const hasBothAuthorizationServerMembers = (nodes) => {
  let hasClientAuthorizationServer = false;
  let hasConnectionAuthorizationServer = false;

  for (const node of nodes) {
    if (isMember(node, MCP_OAUTH_CLIENTS, "authorizationServerUrl")) {
      hasClientAuthorizationServer = true;
    }
    if (isMember(node, MCP_USER_CONNECTIONS, "authorizationServerUrl")) {
      hasConnectionAuthorizationServer = true;
    }
  }

  return hasClientAuthorizationServer && hasConnectionAuthorizationServer;
};

const childNodes = (node) => {
  const children = [];

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          children.push(child);
        }
      }
      continue;
    }
    if (isAstNode(value)) {
      children.push(value);
    }
  }

  return children;
};

const isAstNode = (value) =>
  typeof value === "object" && value !== null && typeof value.type === "string";

const isOAuthResourceUrlFallbackToConnectorUrl = (node) =>
  node.type === "LogicalExpression" &&
  node.operator === "??" &&
  isRowOAuthResourceUrl(node.left) &&
  isRowConnectorUrl(node.right);

const isRowOAuthResourceUrl = (node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  isIdentifier(node.property, "oauthResourceUrl");

const isRowConnectorUrl = (node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  isIdentifier(node.property, "url");

export default {
  meta: { name: "mcp-security" },
  rules: {
    "redact-oauth-registration-response": {
      meta: {
        type: "problem",
        messages: {
          unredactedRegistrationResponse:
            "Persist MCP OAuth registrationResponse only via redactMcpOAuthRegistrationResponse(...). DCR responses can contain client secrets or registration tokens.",
        },
      },
      create(context) {
        return {
          Property(node) {
            if (getPropertyName(node.key) !== "registrationResponse") {
              return;
            }

            if (isRedactionCall(node.value)) {
              return;
            }

            context.report({
              node,
              messageId: "unredactedRegistrationResponse",
            });
          },
        };
      },
    },

    "join-oauth-client-by-authorization-server": {
      meta: {
        type: "problem",
        messages: {
          missingAuthorizationServerJoin:
            "Join mcpOAuthClients with mcpUserConnections.authorizationServerUrl. Joining only by connector can refresh with credentials for the wrong authorization server.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isJoinCall(node)) {
              return;
            }

            const joinCondition = node.arguments.at(1);
            if (hasAuthorizationServerJoinPredicate(joinCondition)) {
              return;
            }

            context.report({
              node,
              messageId: "missingAuthorizationServerJoin",
            });
          },
        };
      },
    },

    "no-oauth-resource-url-fallback": {
      meta: {
        type: "problem",
        messages: {
          resourceUrlFallback:
            "Do not fall back from oauthResourceUrl to connector url during OAuth refresh. Mark the connection for reauth instead.",
        },
      },
      create(context) {
        return {
          LogicalExpression(node) {
            if (!isOAuthResourceUrlFallbackToConnectorUrl(node)) {
              return;
            }

            context.report({
              node,
              messageId: "resourceUrlFallback",
            });
          },
        };
      },
    },
  },
};
