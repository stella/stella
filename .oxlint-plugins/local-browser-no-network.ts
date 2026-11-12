// The local browser transport carries page content between the member's
// Chrome and a coding agent on the same computer. It must not be able to
// send that content anywhere else: no fetch or HTTP client, no WebSocket,
// EventSource, XMLHttpRequest or beacon, no TLS or UDP socket, and Node
// sockets only to a Unix socket path. Servers stay allowed: the bridge
// listens on a Unix socket and the MCP endpoint on 127.0.0.1.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import { createNetworkCallDetector } from "./network-call.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  NAMESPACE_IMPORT,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const BANNED_MODULES = new Set([
  "@stll/api-client",
  "@stll/fetch",
  "axios",
  "dgram",
  "got",
  "http",
  "http2",
  "https",
  "ky",
  "node-fetch",
  "node:dgram",
  "node:http",
  "node:http2",
  "node:https",
  "node:tls",
  "tls",
  "undici",
  "ws",
]);

const NET_MODULES = new Set(["net", "node:net"]);
const NET_CONNECTORS = new Set(["connect", "createConnection"]);
const NET_SOCKETS = new Set(["Socket", "Stream"]);
const MODULE_OBJECTS = new Set(["default", NAMESPACE_IMPORT]);
/** Objects whose members are the globals themselves. */
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window"]);
const NETWORK_CONSTRUCTORS = new Set([
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
]);
/** Options that point a Node socket at a host instead of a path. */
const REMOTE_OPTIONS = new Set(["host", "port", "localAddress"]);

const getField = (node: unknown, field: string): unknown =>
  typeof node === "object" && node !== null && field in node
    ? Reflect.get(node, field)
    : null;

/** Whether a Node connect call names a Unix socket path and nothing remote. */
const connectsToPath = (args: unknown): boolean => {
  if (!Array.isArray(args)) {
    return false;
  }
  const options = unwrapExpression(args.at(0));
  if (options?.type !== "ObjectExpression") {
    return false;
  }
  const properties = getField(options, "properties");
  if (!Array.isArray(properties)) {
    return false;
  }
  const keys = properties.map((property) =>
    isAstNode(property) && property.type === "Property"
      ? getPropertyName(property.key)
      : null,
  );
  // A spread could carry a host or port.
  return (
    keys.includes("path") &&
    keys.every((key) => key !== null && !REMOTE_OPTIONS.has(key))
  );
};

export default eslintCompatPlugin({
  meta: { name: "local-browser-no-network" },
  rules: {
    "local-browser-no-network": {
      meta: {
        type: "problem",
        messages: {
          networkClient:
            "The local browser transport keeps page content on this computer: no network client here. Talk to the holder over its Unix socket.",
          bannedModule:
            "The local browser transport keeps page content on this computer: `{{source}}` is a network client.",
        },
      },
      createOnce(context) {
        const isNetworkCall = createNetworkCallDetector(context);
        const isUnboundIdentifier = (node: unknown): string | null => {
          const expression = unwrapExpression(node);
          if (!isIdentifier(expression) || !isIdentifierReference(expression)) {
            return null;
          }
          // A built-in global resolves to a variable with no declaration.
          const variable = resolveVariable(context, expression);
          return variable === null || variable.defs.length === 0
            ? expression.name
            : null;
        };
        // The global a reference names, written bare (`WebSocket`) or on a
        // global object (`globalThis.WebSocket`, `window.navigator`), and
        // not shadowed by a local; `null` for anything else.
        const globalName = (node: unknown): string | null => {
          const bare = isUnboundIdentifier(node);
          if (bare !== null) {
            return bare;
          }
          const expression = unwrapExpression(node);
          if (expression?.type !== "MemberExpression") {
            return null;
          }
          const owner = globalName(expression.object);
          return owner !== null && GLOBAL_OBJECTS.has(owner)
            ? memberPropertyName(expression)
            : null;
        };
        // The `node:net` export a callee names: `connect` imported by
        // name, or `net.connect` on the module's default or namespace.
        const netExport = (callee: unknown): string | null => {
          const direct = resolveImportedExpressionForEnforcement(
            context,
            callee,
          );
          if (
            direct !== null &&
            NET_MODULES.has(direct.source) &&
            !MODULE_OBJECTS.has(direct.imported)
          ) {
            return direct.imported;
          }
          const expression = unwrapExpression(callee);
          if (expression?.type !== "MemberExpression") {
            return null;
          }
          const base = resolveImportedExpressionForEnforcement(
            context,
            expression.object,
          );
          return base !== null &&
            NET_MODULES.has(base.source) &&
            MODULE_OBJECTS.has(base.imported)
            ? memberPropertyName(expression)
            : null;
        };
        const checkSource = (node: ESTree.Node, source: unknown) => {
          const value = staticStringValue(source);
          if (value !== null && BANNED_MODULES.has(value)) {
            context.report({
              node,
              messageId: "bannedModule",
              data: { source: value },
            });
          }
        };
        return {
          ImportDeclaration(node) {
            checkSource(node, node.source);
          },
          ImportExpression(node) {
            checkSource(node, node.source);
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (isNetworkCall(node)) {
              context.report({ node, messageId: "networkClient" });
              return;
            }
            if (callee?.type === "MemberExpression") {
              const property = memberPropertyName(callee);
              const owner = globalName(callee.object);
              if (
                (property === "sendBeacon" && owner === "navigator") ||
                (property === "connect" && owner === "Bun")
              ) {
                context.report({ node, messageId: "networkClient" });
                return;
              }
            }
            const net = netExport(callee);
            if (
              net !== null &&
              NET_CONNECTORS.has(net) &&
              !connectsToPath(node.arguments)
            ) {
              context.report({ node, messageId: "networkClient" });
            }
          },
          NewExpression(node) {
            const callee = unwrapExpression(node.callee);
            const name = globalName(callee);
            const net = netExport(callee);
            if (
              (name !== null && NETWORK_CONSTRUCTORS.has(name)) ||
              (net !== null && NET_SOCKETS.has(net))
            ) {
              context.report({ node, messageId: "networkClient" });
            }
          },
        };
      },
    },
  },
});
