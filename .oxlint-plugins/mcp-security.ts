// MCP-specific security guardrails.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// These rules encode MCP invariants that are hard for TypeScript to infer at
// persistence/query boundaries:
//   1. OAuth dynamic registration responses must be redacted before JSONB
//      persistence, because some authorization servers return client secrets or
//      registration access tokens in the raw response.
//   2. OAuth client joins must stay behind the typed chat-time MCP connection
//      loader, which normalizes raw nullable DB rows into a discriminated union.

import { getPropertyName, isCallTo, isIdentifier } from "./utils.ts";

const MCP_OAUTH_CLIENTS = "mcpOAuthClients";
const OAUTH_CLIENT_JOIN_ALLOWED_FILES = [
  "apps/api/src/handlers/chat/tools/external-mcp-tools.ts",
];

const isRedactionCall = (node) =>
  isCallTo(node, "redactMcpOAuthRegistrationResponse");

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

const isAllowedOAuthClientJoinFile = (context) => {
  const filename = context.filename ?? context.getFilename?.() ?? "";
  return OAUTH_CLIENT_JOIN_ALLOWED_FILES.some((allowedFile) =>
    filename.endsWith(allowedFile),
  );
};

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

    "no-direct-oauth-client-join": {
      meta: {
        type: "problem",
        messages: {
          directOAuthClientJoin:
            "Load mcpOAuthClients through the typed MCP connection loader. Direct joins can miss authorization-server identity and produce invalid OAuth rows.",
        },
      },
      create(context) {
        const isAllowedFile = isAllowedOAuthClientJoinFile(context);

        return {
          CallExpression(node) {
            if (isAllowedFile || !isJoinCall(node)) {
              return;
            }

            context.report({
              node,
              messageId: "directOAuthClientJoin",
            });
          },
        };
      },
    },
  },
};
