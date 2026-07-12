// Prevents Eden treaty responses from being consumed through promise
// chaining, which lets a failed API call masquerade as success.
//
// `api.*` calls (the Eden treaty proxy from @/lib/api) resolve
// `{ data, error }` and never throw on a normal HTTP error response.
// `.then(cb)` without inspecting `response.error` inside `cb`, and
// `.catch(cb)` tacked on as if it were the error channel, both read as
// error handling while doing nothing of the sort — the exact bug fixed by
// hand in calendar-view.tsx and task-detail-panel.tsx (surfaced only
// because someone happened to notice the silent failure).
//
// Flags:
//   api.tasks({ id }).patch(body).then((response) => { ... })
//   api.tasks({ id }).patch(body).then(cb).catch(cb)
//   api.entities({ id })["some-route"].post(body).catch(cb)
//
// Allows:
//   const response = await api.tasks({ id }).patch(body);
//   if (response.error) { ... }
//   promise.then(cb)            // chain rooted at a non-`api` identifier
//   apiResult.then(cb)          // `api` call already assigned to a variable;
//                                // trace the call site where the variable
//                                // was produced instead
//
// Escape hatch: none by design — every Eden call site should be consumable
// with `await` and an explicit `response.error` check. If a call is
// genuinely fire-and-forget, wrap it in `void (async () => { ... })()` (or
// `Result.tryPromise` for a throwaway mutation) and still check
// `response.error` inside.

import {
  getImportedName,
  getPropertyName,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const API_MODULE = "@/lib/api";

// Same untyped-AST-node shape as utils.ts's private `AstNode`: a `type`
// discriminant plus an index signature so every other property reads back
// as `unknown` (never `any`) without an unsafe cast.
type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

// Walk a call/member chain down to its syntactic root, unwrapping both
// `foo(...)` (CallExpression -> callee) and `foo.bar` / `foo["bar"]`
// (MemberExpression -> object, computed or not) at every step. Returns the
// root Identifier node, or the last non-Identifier node reached (e.g. a
// function expression for an IIFE) when the chain does not root at a bare
// name.
const getChainRoot = (node: unknown): unknown => {
  let current = unwrapExpression(node);
  while (isAstNode(current)) {
    if (current.type === "CallExpression" || current.type === "NewExpression") {
      current = unwrapExpression(current.callee);
      continue;
    }
    if (current.type === "MemberExpression") {
      current = unwrapExpression(current.object);
      continue;
    }
    break;
  }
  return current;
};

export default {
  meta: { name: "require-eden-error-check" },
  rules: {
    "require-eden-error-check": {
      meta: {
        type: "problem",
        messages: {
          requireEdenErrorCheck:
            "Eden response consumed via '.{{method}}()'. api.* calls resolve " +
            "{ data, error } and never throw, so promise chaining can let a " +
            "failed request masquerade as success. Use `const response = " +
            "await api...; if (response.error) { ... }` (toAPIError for the " +
            "message) instead.",
        },
      },
      create(context) {
        const apiLocalNames = new Set<string>();

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== API_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === "api") {
                apiLocalNames.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              callee.computed !== false
            ) {
              return;
            }

            const method = getPropertyName(callee.property);
            if (method !== "then" && method !== "catch") {
              return;
            }

            const root = getChainRoot(callee.object);
            if (!isIdentifier(root) || !apiLocalNames.has(root.name)) {
              return;
            }

            context.report({
              node,
              messageId: "requireEdenErrorCheck",
              data: { method },
            });
          },
        };
      },
    },
  },
};
