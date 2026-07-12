// Prevents Eden treaty responses from being consumed through promise
// chaining or discarded outright, either of which lets a failed API call
// masquerade as success.
//
// `api.*` calls (the Eden treaty proxy from @/lib/api) resolve
// `{ data, error }` and never throw on a normal HTTP error response.
// `.then(cb)` without inspecting `response.error` inside `cb`, and
// `.catch(cb)` tacked on as if it were the error channel, both read as
// error handling while doing nothing of the sort — the exact bug fixed by
// hand in calendar-view.tsx and task-detail-panel.tsx (surfaced only
// because someone happened to notice the silent failure). A bare
// `await api...;` expression statement or a `void api...;` discard drops
// the resolved `{ data, error }` on the floor the same way.
//
// Coverage is intentionally narrow: this rule flags chained consumption
// (`.then`/`.catch`) and *direct* discards (a bare `await api...;`
// statement, a bare fire-and-forget `api...;` statement with no
// `await`/`void` at all, or `void api...`) of an Eden call's own result. It
// does NOT do flow analysis — `const response = api...; /* response never
// checked */` is out of scope, because tracing whether an assigned variable
// is later inspected requires data-flow tracking this rule does not attempt.
//
// Flags:
//   api.tasks({ id }).patch(body).then((response) => { ... })
//   api.tasks({ id }).patch(body).then(cb).catch(cb)
//   api.entities({ id })["some-route"].post(body).catch(cb)
//   await api.tasks({ id }).patch(body);      // bare statement, result discarded
//   api.tasks({ id }).patch(body);            // bare fire-and-forget, no await/void at all
//   void api.tasks({ id }).patch(body);       // explicit discard
//
// Allows:
//   const response = await api.tasks({ id }).patch(body);
//   if (response.error) { ... }
//   promise.then(cb)            // chain rooted at a non-`api` identifier
//   apiResult.then(cb)          // `api` call already assigned to a variable;
//                                // trace the call site where the variable
//                                // was produced instead
//   const response = await api...;  // assigned; not a direct discard, and
//                                     // out of scope per above (no flow
//                                     // analysis of whether `response.error`
//                                     // is later checked)
//   const api = makeScopedClient(); api.tasks({ id }).patch(body);
//                                     // a local `api` that shadows the
//                                     // `@/lib/api` import resolves to a
//                                     // different binding (see scope
//                                     // resolution below) and is not flagged
//
// Escape hatch: none by design — every Eden call site should be consumable
// with `await` and an explicit `response.error` check. If a call is
// genuinely fire-and-forget, wrap it in `void (async () => { ... })()` (or
// `Result.tryPromise` for a throwaway mutation) and still check
// `response.error` inside. If checking the result is truly meaningless for
// a specific best-effort call, suppress with `// eslint-disable-next-line
// require-eden-error-check -- SAFETY: <reason>` rather than leaving the
// discard unexplained.
//
// Shadowing: the root identifier of a flagged chain is resolved through
// oxlint's scope API (`context.sourceCode.getScope` + `Scope.set`, walking
// `.upper` the way ESLint's `findVariable` does) to the `Variable` it
// actually refers to at that use site, and only flagged when that
// variable's declaration is the `api` import from `@/lib/api` itself. A
// local `api` (parameter, destructure, `const api = ...`) that shadows the
// import resolves to a different `Variable` and is left alone.

import {
  getImportedName,
  getPropertyName,
  isIdentifier,
  isStringLiteral,
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

// True when `node` (already unwrapped) is a `.then(...)`/`.catch(...)` call:
// used to keep the direct-discard checks below from double-reporting a call
// chain the CallExpression visitor already flags on its own.
const isThenOrCatchCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false
  ) {
    return false;
  }
  const method = getPropertyName(callee.property);
  return method === "then" || method === "catch";
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
          requireEdenErrorCheckDiscarded:
            "Eden call result discarded via '{{form}}'. api.* calls resolve " +
            "{ data, error } and never throw, so discarding the result can " +
            "let a failed request masquerade as success. Use `const " +
            "response = await api...; if (response.error) { ... }` " +
            "(toAPIError for the message) instead.",
        },
      },
      create(context) {
        const apiLocalNames = new Set<string>();

        // Resolve the `Variable` an Identifier reference binds to by
        // walking the scope chain outward from its use site — the same
        // nearest-enclosing-declaration search ESLint's `findVariable`
        // utility does, built on oxlint's `getScope`/`Scope.set` since this
        // plugin API has no ready-made `findVariable` helper of its own.
        const resolveVariable = (
          identifierNode: AstNode & { name: string },
        ) => {
          let scope = context.sourceCode.getScope(identifierNode);
          while (scope) {
            const variable = scope.set.get(identifierNode.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        // True when `variable` is the binding introduced by `import { api }
        // from "@/lib/api"` (or an aliased form of it) — i.e. the actual
        // import, not a same-named local that shadows it.
        const isApiImportVariable = (
          variable: ReturnType<typeof resolveVariable>,
        ) =>
          variable !== null &&
          variable.defs.some((def) => {
            if (def.type !== "ImportBinding" || !isAstNode(def.node)) {
              return false;
            }
            if (getImportedName(def.node) !== "api") {
              return false;
            }
            if (
              !isAstNode(def.parent) ||
              def.parent.type !== "ImportDeclaration"
            ) {
              return false;
            }
            return (
              isStringLiteral(def.parent.source) &&
              def.parent.source.value === API_MODULE
            );
          });

        // A chain root only counts as a genuine Eden `api` call when it is
        // both spelled like the import (fast pre-check against the
        // `apiLocalNames` set collected from `ImportDeclaration`) and
        // resolves, through scope, to that same import binding rather than
        // a local shadow (parameter, destructure, `const api = ...`).
        const isGenuineApiRoot = (root: unknown): boolean => {
          if (!isIdentifier(root) || !apiLocalNames.has(root.name)) {
            return false;
          }
          return isApiImportVariable(resolveVariable(root));
        };

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
            if (!isGenuineApiRoot(root)) {
              return;
            }

            context.report({
              node,
              messageId: "requireEdenErrorCheck",
              data: { method },
            });
          },

          // `await api...;` as a bare expression statement, or a bare
          // fire-and-forget `api...;` statement with no `await`/`void` at
          // all: the resolved `{ data, error }` is never bound to anything,
          // so `error` can never be inspected.
          ExpressionStatement(node) {
            const expression = unwrapExpression(node.expression);
            if (!isAstNode(expression)) {
              return;
            }

            if (expression.type === "AwaitExpression") {
              const argument = unwrapExpression(expression.argument);
              // Already flagged by the CallExpression visitor above; do not
              // double-report the same discard.
              if (isThenOrCatchCall(argument)) {
                return;
              }

              const root = getChainRoot(argument);
              if (!isGenuineApiRoot(root)) {
                return;
              }

              context.report({
                node,
                messageId: "requireEdenErrorCheckDiscarded",
                data: { form: "await api...;" },
              });
              return;
            }

            if (expression.type === "CallExpression") {
              // Already flagged by the CallExpression visitor above (as
              // chained consumption) or would be a false match on a call
              // that merely ends in a differently-named method; do not
              // double-report `.then()`/`.catch()` chains here.
              if (isThenOrCatchCall(expression)) {
                return;
              }

              const root = getChainRoot(expression);
              if (!isGenuineApiRoot(root)) {
                return;
              }

              context.report({
                node,
                messageId: "requireEdenErrorCheckDiscarded",
                data: { form: "api...; (no await, no void)" },
              });
            }
          },

          // `void api...;`: an explicit discard of the resolved
          // `{ data, error }`.
          UnaryExpression(node) {
            if (node.operator !== "void") {
              return;
            }

            const argument = unwrapExpression(node.argument);
            // Already flagged by the CallExpression visitor above; do not
            // double-report the same discard.
            if (isThenOrCatchCall(argument)) {
              return;
            }

            const root = getChainRoot(argument);
            if (!isGenuineApiRoot(root)) {
              return;
            }

            context.report({
              node,
              messageId: "requireEdenErrorCheckDiscarded",
              data: { form: "void api..." },
            });
          },
        };
      },
    },
  },
};
