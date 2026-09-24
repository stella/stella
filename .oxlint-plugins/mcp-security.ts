// MCP-specific security guardrails.
// These rules encode MCP invariants that are hard for TypeScript to infer at
// persistence/query boundaries:
//   1. OAuth dynamic registration responses must be redacted before JSONB
//      persistence, because some authorization servers return client secrets or
//      registration access tokens in the raw response.
//   2. OAuth client joins must stay behind the typed chat-time MCP connection
//      loader, which normalizes raw nullable DB rows into a discriminated union.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type ImportedFromOptions,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isFileIn,
  isImportedFrom,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const MCP_OAUTH_CLIENTS: ReadonlySet<string> = new Set(["mcpOAuthClients"]);
const MCP_OAUTH_CLIENTS_MODULES = [
  "apps/api/src/db/schema",
  "apps/api/src/db/schema/mcp",
];
const REDACTOR: ReadonlySet<string> = new Set([
  "redactMcpOAuthRegistrationResponse",
]);
const REDACTOR_MODULE =
  "apps/api/src/lib/mcp-upstream/oauth-registration-response";
const JOIN_METHODS: ReadonlySet<string> = new Set(["leftJoin", "innerJoin"]);
const OAUTH_CLIENT_JOIN_ALLOWED_FILES = [
  "apps/api/src/handlers/chat/tools/external-mcp-tools.ts",
];

const isRedactionCall = (context: RuleContext, node: unknown): boolean => {
  const call = unwrapExpression(node);
  return (
    call?.type === "CallExpression" &&
    isImportedFrom({
      context,
      node: invokedCallee(call),
      modules: [REDACTOR_MODULE],
      names: REDACTOR,
    })
  );
};

const isOAuthClientJoin = (context: RuleContext, node: unknown): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  return (
    method !== null &&
    JOIN_METHODS.has(method) &&
    Array.isArray(call.arguments) &&
    isImportedFrom({
      context,
      node: call.arguments.at(0),
      modules: MCP_OAUTH_CLIENTS_MODULES,
      names: MCP_OAUTH_CLIENTS,
    })
  );
};

export default eslintCompatPlugin({
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
      createOnce(context) {
        return {
          Property(node) {
            // A destructuring pattern reads the field; it does not persist it.
            const owner = node.parent;
            if (
              getPropertyName(node.key) !== "registrationResponse" ||
              (isAstNode(owner) && owner.type === "ObjectPattern") ||
              isRedactionCall(context, node.value)
            ) {
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
      createOnce(context) {
        let isAllowedFile = false;

        return {
          before() {
            isAllowedFile = isFileIn(context, OAUTH_CLIENT_JOIN_ALLOWED_FILES);
          },
          CallExpression(node) {
            if (isAllowedFile || !isOAuthClientJoin(context, node)) {
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
});
