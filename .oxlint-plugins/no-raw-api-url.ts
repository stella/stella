import { eslintCompatPlugin } from "@oxlint/plugins";
// Ban hand-written API URL strings in fetch() / new Request() / new URL(),
// and confine the two deployment API bases to their owning resolver.
//
// The browser API is deliberately routed through the web origin's `/api`
// prefix. The separately advertised API origin remains public for desktop,
// CLI, MCP, and integrations. A browser call that reaches directly for
// `env.VITE_API_URL` silently restores CORS preflights; a hand-written `/api`
// path bypasses the prefix/rewrite contract and can drift from it.
//
// Hardcoding `${env.VITE_API_URL}/v1/...` is the same latent bug a step
// removed: the API origin and the `/v1` version prefix get re-typed at
// every callsite instead of living in one place.
//
// Allowed:
//   - apiUrl(`/entities/...`) from `@/lib/api-url` (owns origin + `/v1`)
//   - the Eden treaty client (`@/lib/api`) — compile-time route checking
//   - browserApiUrl()/browserApiBaseUrl from `@/lib/api-origins`
//   - externalApiUrl()/externalApiOrigin for explicit non-browser handoffs
//   - other service bases (e.g. `${DESKTOP_BRIDGE_URL}/v1/...`)
//
// Flagged (first argument of fetch / new Request / new URL):
//   - a string literal starting with `/api` or `/v1`
//   - a template literal starting with `/api` or `/v1`
//   - a template literal starting with `${env.VITE_API_URL}` then `/v1`

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  isStringLiteral,
} from "./utils.ts";

// `/api...` or `/v1...` — a relative path that must not be fetched
// directly, or a versioned path that belongs behind apiUrl().
const RELATIVE_API_PATH = /^\/(?:api|v1)(?:\/|$)/u;
const V1_PATH = /^\/v1(?:\/|$)/u;

type AstNode = Record<string, unknown> & { type: string };

const API_ENV_KEYS = ["VITE_API_URL", "VITE_BROWSER_API_URL"] as const;
const API_ENV_OWNERS = [
  "apps/web/src/env.ts",
  "apps/web/src/lib/api-origins.ts",
] as const;

const isDirectApiEnvAccess = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  isIdentifier(node.object, "env") &&
  API_ENV_KEYS.some((key) => getPropertyName(node.property) === key);

// Raw text of a TemplateLiteral quasi (the static chunk between `${}`
// holes) at `index`. Returns null when the index or node shape is off.
const quasiText = (template: AstNode, index: number): string | null => {
  const quasis = template.quasis;
  if (!Array.isArray(quasis)) {
    return null;
  }
  const element = quasis[index];
  if (!isAstNode(element)) {
    return null;
  }
  const value = element.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = (value as { raw?: unknown }).raw;
  return typeof raw === "string" ? raw : null;
};

// True when `arg` is a URL that should be built with apiUrl() instead.
const isHandWrittenApiUrl = (arg: unknown): boolean => {
  if (isStringLiteral(arg)) {
    return RELATIVE_API_PATH.test(arg.value);
  }
  if (!isAstNode(arg) || arg.type !== "TemplateLiteral") {
    return false;
  }

  const head = quasiText(arg, 0);
  if (head !== null && RELATIVE_API_PATH.test(head)) {
    return true;
  }

  // `${env.VITE_API_URL}` is the leading interpolation; `/v1...` follows.
  const expressions = arg.expressions;
  if (head !== "" || !Array.isArray(expressions)) {
    return false;
  }
  if (!isMemberAccess(expressions[0], "env", "VITE_API_URL")) {
    return false;
  }
  const next = quasiText(arg, 1);
  return next !== null && V1_PATH.test(next);
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-api-url" },
  rules: {
    "no-direct-api-env": {
      meta: {
        type: "problem",
        messages: {
          directApiEnv:
            "Read API deployment bases through '@/lib/api-origins'. The " +
            "browser and externally advertised API endpoints have different " +
            "security and transport contracts.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return !API_ENV_OWNERS.some((owner) => filename.endsWith(owner));
          },
          MemberExpression(node: unknown) {
            if (isDirectApiEnvAccess(node)) {
              context.report({ node, messageId: "directApiEnv" });
            }
          },
        };
      },
    },
    "no-raw-api-url": {
      meta: {
        type: "problem",
        messages: {
          rawApiUrl:
            "Build API URLs with apiUrl()/browserApiUrl() or call the Eden " +
            "client. The shared resolver owns the same-origin `/api` prefix.",
        },
      },
      createOnce(context) {
        const checkFirstArg = (args: unknown) => {
          if (!Array.isArray(args) || args.length === 0) {
            return;
          }
          if (isHandWrittenApiUrl(args[0])) {
            context.report({ node: args[0], messageId: "rawApiUrl" });
          }
        };

        return {
          CallExpression(node: unknown) {
            if (isAstNode(node) && isIdentifier(node.callee, "fetch")) {
              checkFirstArg(node.arguments);
            }
          },
          NewExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            if (
              isIdentifier(node.callee, "Request") ||
              isIdentifier(node.callee, "URL")
            ) {
              checkFirstArg(node.arguments);
            }
          },
        };
      },
    },
  },
});
