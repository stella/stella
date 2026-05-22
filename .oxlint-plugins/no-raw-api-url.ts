// Ban hand-written API URL strings in fetch() / new Request() / new URL().
//
// Bug class: a relative path like `fetch("/api/entities/...")` resolves
// against the *web* origin, not the API. There is no `/api` dev proxy, so
// the Vite SPA fallback answers `200` + index.html; the caller then treats
// HTML as the response body. The failure is silent — `response.ok` is true.
//
// Hardcoding `${env.VITE_API_URL}/v1/...` is the same latent bug a step
// removed: the API origin and the `/v1` version prefix get re-typed at
// every callsite instead of living in one place.
//
// Allowed:
//   - apiUrl(`/entities/...`) from `@/lib/api-url` (owns origin + `/v1`)
//   - the Eden treaty client (`@/lib/api`) — compile-time route checking
//   - `${env.VITE_API_URL}/health` and other unversioned, non-`/v1` paths
//   - other service bases (e.g. `${DESKTOP_BRIDGE_URL}/v1/...`)
//
// Flagged (first argument of fetch / new Request / new URL):
//   - a string literal starting with `/api` or `/v1`
//   - a template literal starting with `/api` or `/v1`
//   - a template literal starting with `${env.VITE_API_URL}` then `/v1`

import { isIdentifier, isMemberAccess, isStringLiteral } from "./utils.ts";

// `/api...` or `/v1...` — a relative path that must not be fetched
// directly, or a versioned path that belongs behind apiUrl().
const RELATIVE_API_PATH = /^\/(?:api|v1)(?:\/|$)/u;
const V1_PATH = /^\/v1(?:\/|$)/u;

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  report: (descriptor: { node: unknown; messageId: "rawApiUrl" }) => void;
};

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { type: unknown }).type === "string";

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

export default {
  meta: { name: "no-raw-api-url" },
  rules: {
    "no-raw-api-url": {
      meta: {
        type: "problem",
        messages: {
          rawApiUrl:
            "Build API URLs with apiUrl() from '@/lib/api-url', or call " +
            "the Eden client ('@/lib/api'). A relative path such as " +
            "'/api/...' resolves against the web origin, not the API.",
        },
      },
      create(context: RuleContext) {
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
};
